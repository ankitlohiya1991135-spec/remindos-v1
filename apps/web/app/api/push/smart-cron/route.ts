/**
 * /api/push/smart-cron — gentle, ADHD-friendly engagement nudges.
 *
 * Called every 2 hours by the Convex cron. Sends a warm, low-pressure,
 * personalised push ("fragrant garden, not iron cage") to users who:
 *   1. Have opted in to smart nudges (smartNudgeEnabled = true on their subscription)
 *   2. Have NOT opened the app in the past 2 h (inactivity gate)
 *   3. Have at least one pending reminder
 *   4. Are NOT in quiet hours (10 PM – 8 AM local time)
 *   5. Haven't already received a smart nudge in the last 12 h (dedup)
 *
 * Max 1 smart nudge per user per day — notification fatigue is real.
 */

import { NextResponse } from "next/server";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { sendWebPushToUser } from "../../../../lib/server/send-web-push";
import {
  determineTier,
  generateNotification,
  type Tier,
  type CopyContext,
  type NotificationType,
} from "../../../../lib/server/notifications/engine";

// ── constants ──────────────────────────────────────────────────────────────────

// How long a user must be inactive before we send a smart nudge.
// Default 2 h — catches users who've closed the app for a couple of hours.
// Override with SMART_NUDGE_INACTIVITY_HOURS env var (e.g. set to 24 for stricter).
const INACTIVITY_THRESHOLD_MS = Number(process.env.SMART_NUDGE_INACTIVITY_HOURS ?? "2") * 60 * 60_000;
const DEDUP_WINDOW_MS          = 12 * 60 * 60_000;  // at most ~1 gentle nudge per 12 h — clarity over clutter
const QUIET_START_HOUR         = 22;                 // 10 PM local time
const QUIET_END_HOUR           = 8;                  // 8  AM local time

// ── quiet-hours helper ─────────────────────────────────────────────────────────

/**
 * Returns true if `now` falls inside quiet hours for the given IANA timezone.
 * Quiet window wraps midnight (e.g. 22 → 8).
 * Per-user quietStart/quietEnd override the global defaults.
 */
function isQuietHours(
  timeZone = "Asia/Kolkata",
  quietStart = QUIET_START_HOUR,
  quietEnd = QUIET_END_HOUR,
): boolean {
  try {
    const localHour = parseInt(
      new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        hour12: false,
        timeZone,
      }).format(new Date()),
      10,
    );
    return localHour >= quietStart || localHour < quietEnd;
  } catch {
    const h = new Date().getUTCHours();
    return h >= quietStart || h < quietEnd;
  }
}

// ── dedup helpers ──────────────────────────────────────────────────────────────

async function alreadySentSmartNudge(
  client: ReturnType<typeof getConvexClient>,
  userId: string,
): Promise<boolean> {
  const rows = await client.query(api.pushNotificationLogs.listRecentForUser, {
    userId,
    type: "smart_nudge",
    sinceMs: DEDUP_WINDOW_MS,
  });
  return rows.length > 0;
}

async function recordSmartNudge(
  client: ReturnType<typeof getConvexClient>,
  userId: string,
) {
  await client.mutation(api.pushNotificationLogs.logSent, {
    userId,
    type: "smart_nudge",
    sentAt: Date.now(),
  });
}

// ── message template engine ────────────────────────────────────────────────────

interface NudgeContext {
  daysInactive: number;   // floating-point days since last seen
  pendingCount: number;
  overdueCount: number;
  topDomain?: string | null;
  nextDueTitle?: string | null;
  nextDueAt?: number | null;   // epoch ms of soonest upcoming reminder (for time anchoring)
  displayName?: string | null;
  localHour: number;      // 0-23 in user's timezone
  streakDays: number;     // consecutive active days ending yesterday (0 = no streak)
  hasNoPending: boolean;  // true when user has zero pending reminders/tasks
  tier?: Tier;            // data-richness tier (1=cold start … 3=rich). Defaults to 1 (safest).
  doneToday?: number;     // completions today (for evening soft-close copy)
}

type Template = { title: string; body: string };

function pick<T>(arr: T[]): T {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function localTimeSlot(h: number): "morning" | "afternoon" | "evening" | "night" {
  if (h >= 5  && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

// Streak celebration is not one of the six trigger types — it's a standalone
// "noticing you've been kind to yourself" moment. CELEBRATE, never threaten.
function streakCopy(streakDays: number, displayName?: string | null): Template {
  const name = displayName ? ` ${displayName.split(" ")[0]}` : "";
  if (streakDays >= 7) {
    return pick<Template>([
      { title: `${streakDays} days in a row 🌱`, body: `that's real momentum${name}. however today goes, you've already built something.` },
      { title: "look at you go 🔥", body: `${streakDays} days showing up. for an adhd brain that's genuinely big. proud of you.` },
      { title: "quiet little streak 🌟", body: `${streakDays} days in. no pressure to keep it — just noticing you've been kind to yourself.` },
    ]);
  }
  return pick<Template>([
    { title: `${streakDays} days, nice 🌱`, body: `you've shown up a few days running${name}. that counts for a lot.` },
    { title: "momentum's a real thing 🌿", body: `${streakDays} days in a row. whatever happens next, this was good.` },
  ]);
}

// Empty-state copy — the user has nothing pending. Warm, no pressure to fill it.
function allClearCopy(slot: ReturnType<typeof localTimeSlot>, displayName?: string | null): Template {
  const name = displayName ? ` ${displayName.split(" ")[0]}` : "";
  if (slot === "morning") {
    return pick<Template>([
      { title: `morning${name} 🌅`, body: "nothing pressing right now. if something's on your mind, i can help you sort it." },
      { title: "clear slate ☀️", body: "nothing pending today. enjoy it — i'm here if you want to plan anything." },
    ]);
  }
  if (slot === "evening" || slot === "night") {
    return pick<Template>([
      { title: `evening${name} 🌙`, body: "all clear for now. rest easy — tomorrow can wait until tomorrow." },
      { title: "nice and quiet 🌿", body: "nothing on the list. if you want, jot down tomorrow's one thing and let it go." },
    ]);
  }
  return pick<Template>([
    { title: "all clear 🤍", body: `nothing pending right now${name}. i'm here whenever you need to capture something.` },
    { title: "breathing room 🌱", body: "your list is empty. no pressure to fill it — just here if you need me." },
  ]);
}

/**
 * Build a gentle, tier-aware engagement nudge.
 *
 * Streaks and the empty state are handled inline (they aren't one of the six
 * trigger types). Everything task-driven is delegated to the shared engine,
 * which scales personalization to the user's data-richness tier and runs every
 * string through the anti-surveillance validator — so a cold-start user never
 * gets a fabricated "this has been pending 3 days" claim.
 */
export function generateSmartNudgeMessage(ctx: NudgeContext): Template {
  const tier: Tier = ctx.tier ?? 1;
  const slot = localTimeSlot(ctx.localHour);
  const now = Date.now();
  const minutesUntilDue =
    ctx.nextDueAt && ctx.nextDueAt > now ? Math.round((ctx.nextDueAt - now) / 60_000) : null;

  // 1. Celebrate a real streak (tier 2+ only — needs genuine history).
  if (tier >= 2 && ctx.streakDays >= 3) return streakCopy(ctx.streakDays, ctx.displayName);

  // 2. Nothing pending → warm empty-state.
  if (ctx.hasNoPending) return allClearCopy(slot, ctx.displayName);

  const copyCtx: CopyContext = {
    tier,
    displayName: ctx.displayName,
    focusTaskTitle: ctx.nextDueTitle ?? null,
    nextDueTitle: ctx.nextDueTitle ?? null,
    minutesUntilDue,
    pendingCount: ctx.pendingCount,
    overdueCount: ctx.overdueCount,
    doneToday: ctx.doneToday ?? 0,
    streakDays: ctx.streakDays,
  };

  // 3. A genuinely heavy overdue load → Overwhelm Rescue (tier 2+, rare).
  if (tier >= 2 && ctx.overdueCount >= 5) return generateNotification("overwhelm_rescue", copyCtx);

  // 4. Otherwise map the moment to one of the six types.
  let type: NotificationType;
  if (slot === "morning") type = "morning_launch";
  else if (slot === "evening" || slot === "night") type = "evening_soft_close";
  else if (minutesUntilDue != null && minutesUntilDue <= 180) type = "time_anchor";
  else type = "just_start";

  return generateNotification(type, copyCtx);
}

// ── GET: health check + diagnostics ────────────────────────────────────────────
export async function GET() {
  const vapidOk = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const cronSecretSet = !!process.env.CRON_SECRET;
  const convexUrlSet = !!(process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL);
  let subscriptionCount = 0;
  let eligibleUserCount = 0;
  try {
    const client = getConvexClient();
    const subs = await client.query(api.pushSubscriptions.listAllUsers, {});
    subscriptionCount = subs.length;
    const eligible = new Set<string>();
    for (const s of subs) {
      if (s.smartNudgeEnabled !== false) eligible.add(s.userId);
    }
    eligibleUserCount = eligible.size;
  } catch { /* ignore */ }
  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    diagnostics: {
      vapidConfigured: vapidOk,
      cronSecretSet,
      convexUrlSet,
      subscriptionCount,
      eligibleUserCount,
      inactivityThresholdHours: INACTIVITY_THRESHOLD_MS / 3_600_000,
      dedupWindowHours: DEDUP_WINDOW_MS / 3_600_000,
      note: "POST this endpoint with `Authorization: Bearer <CRON_SECRET>` to actually run the smart-nudge sweep.",
    },
  });
}

// ── POST: cron worker ──────────────────────────────────────────────────────────
export async function POST(request: Request) {
  // Verify cron secret. Accepts the bearer token in either:
  //   1. Authorization header (preferred — used by Vercel cron + cron-job.org + Convex cron)
  //   2. ?secret=<token> query string (fallback for services that can't set headers)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("authorization");
    const url = new URL(request.url);
    const querySecret = url.searchParams.get("secret");
    const headerOk = authHeader === `Bearer ${secret}`;
    const queryOk = querySecret === secret;
    if (!headerOk && !queryOk) {
      console.warn(`[push/smart-cron] 401 unauthorized — auth header present=${!!authHeader}, query secret present=${!!querySecret}`);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const client = getConvexClient();
  const now = Date.now();
  const results = { sent: 0, skipped_active: 0, skipped_quiet: 0, skipped_dedup: 0, skipped_empty: 0, errors: 0 };

  const vapidOk = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (!vapidOk) {
    console.error("[push/smart-cron] VAPID keys missing — no push notifications will be sent. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel env vars.");
  }

  try {
    // ── 1. Get all subscriptions (we filter in-memory for smartNudgeEnabled) ────
    const allSubs = await client.query(api.pushSubscriptions.listAllUsers, {});

    // Build: userId → { timeZone, displayName } — take first match per user.
    const userMeta = new Map<string, { timeZone?: string; displayName?: string; quietStartHour?: number; quietEndHour?: number }>();
    for (const sub of allSubs) {
      // Opt-OUT model: only skip users who explicitly disabled smart nudges.
      // undefined (never set) = included. false = excluded.
      if (sub.smartNudgeEnabled === false) continue;
      if (!userMeta.has(sub.userId)) {
        userMeta.set(sub.userId, {
          timeZone: sub.timeZone,
          displayName: sub.displayName,
          quietStartHour: sub.quietStartHour,
          quietEndHour: sub.quietEndHour,
        });
      }
    }

    const userIds = [...userMeta.keys()];
    console.log(`[push/smart-cron] tick — ${userIds.length} eligible users (smartNudge=true), vapidOk=${vapidOk}, inactivityThresholdH=${INACTIVITY_THRESHOLD_MS / 3_600_000}, utc=${new Date(now).toISOString()}`);

    for (const userId of userIds) {
      try {
        const meta = userMeta.get(userId)!;
        const tz = meta.timeZone ?? "Asia/Kolkata";

        // ── 1a. Quiet hours check (uses per-user window if set) ─────────────────
        if (isQuietHours(tz, meta.quietStartHour, meta.quietEndHour)) {
          console.log(`[push/smart-cron] user=${userId} SKIPPED quiet_hours tz=${tz}`);
          results.skipped_quiet += 1;
          continue;
        }

        // ── 1b. Inactivity check ────────────────────────────────────────────────
        const lastSeenAt = await client.query(api.userSessions.getLastSeenAt, { userId });
        const msSinceActive = lastSeenAt ? now - lastSeenAt : Infinity;
        const hoursInactive = Math.round(msSinceActive / 3_600_000 * 10) / 10;
        if (msSinceActive < INACTIVITY_THRESHOLD_MS) {
          console.log(`[push/smart-cron] user=${userId} SKIPPED too_active — lastSeen ${hoursInactive}h ago (threshold ${INACTIVITY_THRESHOLD_MS / 3_600_000}h)`);
          results.skipped_active += 1;
          continue;
        }
        const daysInactive = msSinceActive / 86_400_000;

        // ── 1c. Dedup — max 1 nudge per 6 h ─────────────────────────────────────
        if (await alreadySentSmartNudge(client, userId)) {
          console.log(`[push/smart-cron] user=${userId} SKIPPED dedup — already sent within ${DEDUP_WINDOW_MS / 3_600_000}h`);
          results.skipped_dedup += 1;
          continue;
        }

        // ── 1d. Reminder stats ───────────────────────────────────────────────────
        const stats = await client.query(api.reminders.getSmartNudgeStats, { userId });
        // Do NOT skip users with 0 pending reminders — they still get AI engagement
        // notifications (Types 1, 3, 5, 6, 8, 9) to bring them back to the app.

        // ── 1e. Streak + data-richness tier from recent events ──────────────────
        // We only have a 30-day event window, so every derived signal is a
        // CONSERVATIVE lower bound — which is exactly the safe direction for
        // tiering (under-estimating data keeps personalization from running
        // ahead of what we can actually support; see engine.determineTier).
        let streakDays = 0;
        let tier: Tier = 1;
        let doneToday = 0;
        try {
          const recentEvents = await client.query(api.userEvents.getRecent, { userId, limitDays: 30 });
          const dayKey = (ms: number) => {
            const d = new Date(ms);
            return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
          };
          const activeDays = new Set<string>();
          let earliest = now;
          let completions = 0;
          const todayKey = dayKey(now);
          for (const e of recentEvents) {
            activeDays.add(dayKey(e.createdAt));
            if (e.createdAt < earliest) earliest = e.createdAt;
            if (e.eventType === "reminder_completed" || e.eventType === "task_completed") {
              completions++;
              if (dayKey(e.createdAt) === todayKey) doneToday++;
            }
          }
          // Count consecutive days ending yesterday (today the user is inactive).
          for (let i = 1; i <= 30; i++) {
            if (!activeDays.has(dayKey(now - i * 86_400_000))) break;
            streakDays++;
          }
          tier = determineTier({
            accountAgeDays: Math.floor((now - earliest) / 86_400_000),
            activeDaysCount: activeDays.size,
            totalCompletions: completions,
          });
        } catch { /* non-critical — defaults: streak 0, tier 1 (safest) */ }

        // ── 1f. Build message ───────────────────────────────────────────────────
        const localHour = (() => {
          try {
            return parseInt(
              new Intl.DateTimeFormat("en", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()),
              10,
            );
          } catch { return new Date().getUTCHours(); }
        })();

        const { title, body } = generateSmartNudgeMessage({
          daysInactive,
          pendingCount:  stats.pendingCount,
          overdueCount:  stats.overdueCount,
          topDomain:     stats.topDomain,
          nextDueTitle:  stats.nextDueTitle,
          nextDueAt:     stats.nextDueAt,
          displayName:   meta.displayName,
          localHour,
          streakDays,
          hasNoPending:  stats.pendingCount === 0,
          tier,
          doneToday,
        });

        // ── 1f. Send push ───────────────────────────────────────────────────────
        const sentCount = await sendWebPushToUser(userId, {
          type: "smart_nudge",
          title,
          body,
          pendingCount: stats.pendingCount,
          overdueCount: stats.overdueCount,
        });

        // Only record dedup and persist to notification centre if at least one
        // push was accepted by FCM. Recording dedup unconditionally would block
        // retries for the next 6 h even when the send silently failed (e.g. all
        // subscriptions returned 401/403 due to a VAPID key mismatch).
        if (sentCount > 0) {
          await recordSmartNudge(client, userId);
          await client.mutation(api.notifications.create, {
            userId,
            type: "smart_nudge",
            title,
            body,
          });
          console.log(`[push/smart-cron] user=${userId} SENT smart_nudge (${sentCount}) — "${title}" (inactive ${Math.round(daysInactive * 10) / 10}d, pending=${stats.pendingCount}, overdue=${stats.overdueCount})`);
          results.sent += 1;
        } else {
          console.warn(`[push/smart-cron] user=${userId} send returned 0 — dedup NOT recorded (will retry next cycle)`);
        }
      } catch (userErr) {
        console.error(`[push/smart-cron] user=${userId} ERROR:`, userErr);
        results.errors += 1;
      }
    }

    console.log(`[push/smart-cron] done — ${JSON.stringify(results)}`);
  } catch (err) {
    console.error("[push/smart-cron] fatal error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, results, ts: new Date(now).toISOString() });
}
