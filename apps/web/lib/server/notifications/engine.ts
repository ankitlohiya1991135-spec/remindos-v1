/**
 * notifications/engine.ts — the ADHD-friendly notification engine.
 *
 * Philosophy: "fragrant garden, not iron cage." Every notification must read
 * like a supportive friend who gets it — never a manager watching you. ADHD
 * users live with Rejection Sensitive Dysphoria; one guilt-tripping push can
 * cause an uninstall.
 *
 * This module is PURE and deterministic-where-it-matters (tier + selection are
 * fully deterministic; copy varies via a seedable picker). It has three jobs:
 *
 *   1. determineTier()        — how personal are we allowed to get? (cold-start safety)
 *   2. selectNotification()   — silence checks + which of the 6 types to fire
 *   3. generateNotification() — tier-scaled, anti-surveillance-safe copy
 *
 * The copy is gated through the validator backstop (./validate) so a forbidden
 * phrase can never reach a user even if a template regresses.
 *
 * Everything here is unit-testable without Convex, the network, or a clock —
 * callers pass in already-gathered signals. Wiring lives in the cron routes.
 */

import { safeNotification, violatesGuidelines } from "./validate";

// ── The six notification types ──────────────────────────────────────────────

export type NotificationType =
  | "morning_launch" // daily anchor — reduce the list to ONE thing
  | "just_start" // lower the activation barrier (2-minute rule + body-doubling)
  | "time_anchor" // externalize time without pressure (time blindness)
  | "win_celebration" // dopamine + counter the "i'm lazy" shame spiral
  | "overwhelm_rescue" // reduce visible load + reassure (rare)
  | "evening_soft_close" // break the end-of-day shame spiral
  | "accountability_nudge"; // backlog has grown large — acknowledge it without shame (tier 2+, deduped separately)

export const ALL_TYPES: NotificationType[] = [
  "morning_launch",
  "just_start",
  "time_anchor",
  "win_celebration",
  "overwhelm_rescue",
  "evening_soft_close",
  "accountability_nudge",
];

// ── Data-richness tiers ─────────────────────────────────────────────────────
// Personalization depth must always TRAIL real data, never run ahead of it.
// 1 = cold start, 2 = warming, 3 = rich.

export type Tier = 1 | 2 | 3;

/** Account age + accumulated data volume — the inputs that gate tiering. */
export interface AccountSignals {
  accountAgeDays: number; // days since signup
  activeDaysCount: number; // distinct days with any activity
  totalCompletions: number; // lifetime completed tasks/reminders
}

/**
 * Decide how personal we may get. We take the MIN of an age-based tier and a
 * data-based tier: a 30-day-old account that has only ever been opened twice is
 * still cold-start, and a power user on day 2 still hasn't given us enough
 * history to claim patterns. Personalization trails the weaker signal.
 */
export function determineTier(a: AccountSignals): Tier {
  const ageTier: Tier = a.accountAgeDays >= 15 ? 3 : a.accountAgeDays >= 4 ? 2 : 1;
  const dataTier: Tier =
    a.activeDaysCount >= 7 && a.totalCompletions >= 5
      ? 3
      : a.activeDaysCount >= 2 && a.totalCompletions >= 1
        ? 2
        : 1;
  return Math.min(ageTier, dataTier) as Tier;
}

// ── Selection ───────────────────────────────────────────────────────────────

/** Hard ceiling — NOT a target. Most days send 2–4. */
export const DAILY_CAP = 6;
/** Never cluster notifications; default minimum gap between any two. */
export const COOLDOWN_MINUTES = 90;
/** After a dismissal, back off: require a longer gap and soften. */
export const BACKOFF_COOLDOWN_MINUTES = 240;

/** Everything the selector needs — all gathered by the caller, no side effects. */
export interface SelectionState {
  tier: Tier;
  localHour: number; // 0–23 in the user's timezone
  isWeekend: boolean;
  quietHours: boolean; // already computed against the user's window
  sentInLast24h: number; // count of notifications already sent
  minutesSinceLastNotif: number | null; // null = none sent recently
  lastWasDismissed: boolean; // previous notification was dismissed → back off
  inCompletionFlow: boolean; // user is actively ticking things off — don't interrupt
  // Trigger availability (computed from task/behaviour context):
  justCompletedTask: boolean; // a completion just happened
  isMorningWindow: boolean; // start of the user's active window
  isEveningWindow: boolean; // wind-down window
  stressDetected: boolean; // frantic edits / many reschedules / late-night dumps
  hasApproachingTimedTask: boolean; // a time-bound commitment is near
  hasIdlePendingTask: boolean; // a pending task the user could just start
}

export type SelectionResult =
  | { type: NotificationType }
  | { silent: true; reason: string };

/**
 * Decide whether to send, and if so which type. Win Celebration is the one
 * reactive, always-welcome notification (it rewards an action the user *just
 * took*), so it bypasses the cadence gates — but still respects quiet hours so
 * we never buzz someone at 3am. Everything else runs the full silence gauntlet
 * first, then picks by priority.
 */
export function selectNotification(s: SelectionState): SelectionResult {
  // Win Celebration — highest priority, reactive to the user's own action.
  if (s.justCompletedTask && !s.quietHours) return { type: "win_celebration" };

  // ── Silence checks (any one → stay quiet) ──
  if (s.quietHours) return { silent: true, reason: "quiet_hours" };
  if (s.isWeekend && s.localHour < 10) return { silent: true, reason: "weekend_morning" };
  if (s.sentInLast24h >= DAILY_CAP) return { silent: true, reason: "daily_cap" };
  if (s.inCompletionFlow) return { silent: true, reason: "in_completion_flow" };

  const cooldown = s.lastWasDismissed ? BACKOFF_COOLDOWN_MINUTES : COOLDOWN_MINUTES;
  if (s.minutesSinceLastNotif != null && s.minutesSinceLastNotif < cooldown) {
    return { silent: true, reason: "cooldown" };
  }

  // ── Selection (priority order) ──
  // Overwhelm Rescue overrides mid-day notifications when stress is real.
  // Tier 2+ only — we won't claim "today's a lot" without enough history to mean it.
  if (s.stressDetected && s.tier >= 2) return { type: "overwhelm_rescue" };
  if (s.isMorningWindow) return { type: "morning_launch" };
  if (s.isEveningWindow) return { type: "evening_soft_close" };
  if (s.hasApproachingTimedTask) return { type: "time_anchor" };
  if (s.hasIdlePendingTask) return { type: "just_start" };

  return { silent: true, reason: "nothing_to_say" };
}

// ── Copy generation ───────────────────────────────────────────────────────────

/**
 * Real, user-specific data the copy may reference. Higher-tier fields must only
 * be populated when they are genuinely true — the generator will simply not use
 * what isn't there, and will never fabricate.
 */
export interface CopyContext {
  tier: Tier;
  displayName?: string | null;

  // Task-level (available immediately, all tiers):
  focusTaskTitle?: string | null; // the single most important thing today
  nextDueTitle?: string | null; // upcoming time-bound commitment
  minutesUntilDue?: number | null;
  completedTaskTitle?: string | null;
  completedTaskAgeDays?: number | null; // how long it had been pending (Tier 2+ only when true)
  pendingCount: number;
  overdueCount: number;
  doneToday: number;

  // Patterns — ONLY pass these when the data actually supports them (Tier 2/3):
  peakWindowLabel?: string | null; // e.g. "before 11am"  (Tier 3)
  addedRepeatedly?: boolean; // user re-added this a couple times (Tier 2+)
  streakDays?: number; // consecutive active days (celebrate only)
  topDomain?: string | null; // life domain with the most pending reminders (accountability_nudge, Tier 3)

  /** Optional seed so a given (user, slot) is stable within a tick but varies across sends. */
  seed?: number;
}

export type Copy = { title: string; body: string };

function mkPick(seed?: number) {
  // Deterministic when a seed is supplied (testability), random otherwise.
  let i = seed ?? Math.floor(Math.random() * 1e9);
  return function pick<T>(arr: T[]): T {
    i = (i * 1103515245 + 12345) & 0x7fffffff;
    return arr[i % arr.length]!;
  };
}

function firstName(name?: string | null): string {
  const n = name?.trim().split(/\s+/)[0];
  return n ? ` ${n}` : "";
}

function quoted(title?: string | null): string | null {
  const t = title?.trim();
  return t ? `"${t}"` : null;
}

// Each generator receives the context + a picker and returns raw copy. The
// public generateNotification() applies the validator backstop afterwards.

function morningLaunch(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const name = firstName(ctx.displayName);
  const one = quoted(ctx.focusTaskTitle);
  if (ctx.tier === 1 || !one) {
    return pick<Copy>([
      { title: `morning${name} 🌱`, body: "let's keep it simple — pick one thing to start with. everything else can wait." },
      { title: "easy start ☀️", body: "no need to look at the whole list. just one small thing is plenty for now." },
      { title: `morning${name} 🌿`, body: "fresh start. choose whichever feels lightest and begin there." },
    ]);
  }
  if (ctx.tier === 2) {
    return pick<Copy>([
      { title: `morning${name} 🌱`, body: `forget the whole list — just ${one} matters first. everything else can wait.` },
      { title: "one thing today ☀️", body: `start with ${one}. that's the whole plan for now.` },
    ]);
  }
  // tier 3
  const peak = ctx.peakWindowLabel?.trim();
  return pick<Copy>([
    { title: `morning${name} 🌱`, body: `forget the whole list today — just one thing matters: ${one}. everything else can wait. just start there.` },
    peak
      ? { title: "your sharp hours 🌿", body: `you tend to be at your best ${peak}. if anything gets ${one}, let it be that.` }
      : { title: "just this one ☀️", body: `${one} is the one that moves things today. the rest can wait their turn.` },
  ]);
}

function justStart(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const thing = quoted(ctx.nextDueTitle) ?? quoted(ctx.focusTaskTitle);
  if (ctx.tier === 1 || !thing) {
    return pick<Copy>([
      { title: "just 2 minutes 🌱", body: "pick one thing and give it two minutes. starting is the hard part — it gets easier once you're in." },
      { title: "tiny start 🌿", body: "you don't have to finish anything. just begin for two minutes. i'm right here." },
    ]);
  }
  if (ctx.tier === 2) {
    return pick<Copy>([
      { title: "give it 2 minutes 🌱", body: `${thing} — just two minutes to start. that's all. it gets easier once you're in.` },
      { title: "small first step 🌿", body: `${thing} can start tiny. two minutes, then decide. want a timer? i'm here.` },
    ]);
  }
  return pick<Copy>([
    { title: "just 2 minutes 🌱", body: `${thing} — give it just 2 minutes. starting is the hardest part; it gets easier once you're in. want a 2-min timer? i'm right here.` },
    { title: "i'll start with you 🌿", body: `${thing} only needs two minutes to begin. you don't have to do it all — just open the door.` },
  ]);
}

function timeAnchor(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const thing = quoted(ctx.nextDueTitle) ?? "your next thing";
  const mins = ctx.minutesUntilDue;
  const whenSimple =
    mins != null && mins > 0
      ? mins >= 60
        ? `in about ${Math.round(mins / 60)}h`
        : `in about ${mins} min`
      : "coming up";
  if (ctx.tier === 1) {
    return pick<Copy>([
      { title: "heads-up 🌿", body: `${thing} is ${whenSimple}. no rush — just putting it on your radar.` },
      { title: "on your radar 😌", body: `${thing} is ${whenSimple}. just so you know — no pressure.` },
    ]);
  }
  return pick<Copy>([
    { title: "heads-up 🌿", body: `${thing} is ${whenSimple}. no rush, just so it doesn't slip by quietly. i've got you 😌` },
    { title: "gentle time check ⏳", body: `${thing} ${whenSimple}. time slips quietly sometimes — just anchoring it for you.` },
  ]);
}

function winCelebration(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const thing = quoted(ctx.completedTaskTitle);
  const age = ctx.completedTaskAgeDays ?? 0;
  // Tier 1 / day-0: keep it simple and universal — no age claims.
  if (ctx.tier === 1 || age < 3) {
    return pick<Copy>([
      { title: "done! 🔥", body: thing ? `${thing} — off the list. that counts.` : "that's one off the list. that counts 🔥" },
      { title: "nice one ✨", body: ctx.doneToday > 1 ? `${ctx.doneToday} done today. that's real.` : "first one off the list today. let yourself feel that 🌱" },
    ]);
  }
  // Tier 2+: age reference allowed because it's actually true.
  return pick<Copy>([
    { title: "done! 🔥", body: `${thing ?? "that one"} had been sitting there ${age} days — and you did it. for an adhd brain that's a real win. let yourself feel it.` },
    { title: "that's a big one ✨", body: `${age} days pending, and you closed it${firstName(ctx.displayName)}. that's not small at all.` },
  ]);
}

function overwhelmRescue(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const name = firstName(ctx.displayName);
  // Overwhelm Rescue is Tier 2+ by selection, but keep copy safe regardless.
  return pick<Copy>([
    { title: `breathe${name} 😌`, body: "looks like today's a lot. pause. just pick one — the rest can wait out of sight. you're not the problem, the list is just long. this is enough for today." },
    { title: "one thing is enough 🌿", body: "today feels heavy, and that's okay. choose a single small thing and let the rest go quiet for now. that's a full day's work with an adhd brain." },
    { title: "let's shrink it 🤍", body: "the list got long, not you. pick one, i'll tuck the rest away. enough is enough today." },
  ]);
}

function eveningSoftClose(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const done = ctx.doneToday;
  if (ctx.tier === 1 || done === 0) {
    return pick<Copy>([
      { title: "you did enough today 🌙", body: "whatever didn't happen will keep — tomorrow's there for it. rest easy tonight." },
      { title: "soft close 🌿", body: "getting through an ordinary day is its own kind of win. let the rest wait. rest." },
    ]);
  }
  return pick<Copy>([
    { title: `${done} done today 🌙`, body: "the ones that didn't happen aren't going anywhere — tomorrow's there for them. you did enough. getting through a day with an adhd brain is its own win. rest." },
    { title: "enough for today ✨", body: `${done} things off the list${firstName(ctx.displayName)}. the rest can wait. let yourself stop now 🌙` },
  ]);
}

/**
 * The backlog has grown large but isn't a full "overwhelm" moment (that's
 * overwhelm_rescue, gated on overdueCount >= 5). This acknowledges a sizable
 * pending count plainly — no guilt, no "why haven't you" — just naming what's
 * true and reframing that clearing one thing is enough. Caller is responsible
 * for its own dedup cadence (it repeats far more easily than a one-off rescue).
 */
function accountabilityNudge(ctx: CopyContext, pick: ReturnType<typeof mkPick>): Copy {
  const name = firstName(ctx.displayName);
  const count = ctx.pendingCount;
  if (ctx.tier < 2 || count < 8) {
    return pick<Copy>([
      { title: "a few waiting 🌿", body: "no pressure — when you're ready, even one helps." },
      { title: "whenever you're ready 🤍", body: "a handful are sitting there. pick whichever feels easiest." },
    ]);
  }
  const domainNote = ctx.topDomain ? ` a good chunk of them are ${ctx.topDomain}.` : "";
  return pick<Copy>([
    { title: `${count} pending${name} 🌿`, body: `that's a real backlog now.${domainNote} you don't need to clear them all today — just pick one and let the rest wait.` },
    { title: "let's chip away 🌱", body: `${count} reminders are stacked up.${domainNote} starting with just one counts more than it feels like.` },
    { title: `${count} waiting for you 🤍`, body: "the list got long. that's okay — it's not about clearing it all at once, just moving one thing forward." },
  ]);
}

const GENERATORS: Record<NotificationType, (ctx: CopyContext, pick: ReturnType<typeof mkPick>) => Copy> = {
  morning_launch: morningLaunch,
  just_start: justStart,
  time_anchor: timeAnchor,
  win_celebration: winCelebration,
  overwhelm_rescue: overwhelmRescue,
  evening_soft_close: eveningSoftClose,
  accountability_nudge: accountabilityNudge,
};

/**
 * Produce safe, tier-appropriate copy for a notification type. Always runs the
 * anti-surveillance validator as a backstop — if a template ever regresses into
 * a forbidden phrase, the user gets a guaranteed-clean fallback instead.
 */
export function generateNotification(type: NotificationType, ctx: CopyContext): Copy {
  const pick = mkPick(ctx.seed);
  const raw = GENERATORS[type](ctx, pick);
  const safe = safeNotification(raw.title, raw.body);
  return { title: safe.title ?? raw.title, body: safe.body ?? raw.body };
}

/** Exposed for tests: does this copy pass the anti-surveillance filter? */
export function isCopyClean(c: Copy): boolean {
  return !violatesGuidelines(`${c.title} ${c.body}`);
}
