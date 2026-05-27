/**
 * /api/push/smart-cron — Zomato-style smart engagement nudges.
 *
 * Called every 2 hours by a separate cron-job.org entry.
 * Sends a witty, personalised push to users who:
 *   1. Have opted in to smart nudges (smartNudgeEnabled = true on their subscription)
 *   2. Have NOT opened the app in the past 24 h
 *   3. Have at least one pending reminder
 *   4. Are NOT in quiet hours (10 PM – 8 AM local time)
 *   5. Haven't already received a smart nudge in the last 23 h (dedup)
 *
 * Max 1 smart nudge per user per day — notification fatigue is real.
 */

import { NextResponse } from "next/server";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { sendWebPushToUser } from "../../../../lib/server/send-web-push";

// ── constants ──────────────────────────────────────────────────────────────────

// How long a user must be inactive before we send a smart nudge.
// Default 2 h — catches users who've closed the app for a couple of hours.
// Override with SMART_NUDGE_INACTIVITY_HOURS env var (e.g. set to 24 for stricter).
const INACTIVITY_THRESHOLD_MS = Number(process.env.SMART_NUDGE_INACTIVITY_HOURS ?? "2") * 60 * 60_000;
const DEDUP_WINDOW_MS          = 6 * 60 * 60_000;   // max 1 nudge per 6 h (was 23 h)
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
  displayName?: string | null;
  localHour: number;      // 0-23 in user's timezone
  streakDays: number;     // consecutive active days ending yesterday (0 = no streak)
  hasNoPending: boolean;  // true when user has zero pending reminders/tasks
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

const DOMAIN_EMOJI: Record<string, string> = {
  health: "🏃", finance: "💸", career: "💼", hobby: "🎨", fun: "🎮",
};
const DOMAIN_LABEL: Record<string, string> = {
  health: "fitness", finance: "finances", career: "career",
  hobby: "hobbies", fun: "fun stuff",
};

/**
 * Picks a Zomato-style witty notification from context-appropriate pools.
 * Priority: overdue pile-up → long inactivity → domain focus → time-of-day → generic.
 */
export function generateSmartNudgeMessage(ctx: NudgeContext): Template {
  const {
    daysInactive, pendingCount, overdueCount, topDomain,
    nextDueTitle, displayName, localHour, streakDays, hasNoPending,
  } = ctx;

  const name  = displayName ? `, ${displayName.split(" ")[0]}` : "";
  const slot  = localTimeSlot(localHour);
  const days  = Math.round(daysInactive);
  const emoji = topDomain ? DOMAIN_EMOJI[topDomain] ?? "📌" : "";
  const label = topDomain ? DOMAIN_LABEL[topDomain] ?? topDomain : "";

  // ── Type 7: streak milestone (fires before overdue — loyalty deserves acknowledgement) ──
  if (streakDays >= 7) {
    return pick<Template>([
      { title: `🔥 ${streakDays}-day streak at risk!`, body: `You were on a roll${name}! Open the app today to keep the streak alive.` },
      { title: "Incredible consistency! 🏆", body: `${streakDays} days in a row with MYSA — don't let it end now!` },
      { title: `${streakDays}-day streak on the line 🎯`, body: `Come back today${name} and protect what you've built 💪` },
    ]);
  }
  if (streakDays >= 3) {
    return pick<Template>([
      { title: `⚡ ${streakDays}-day streak at risk!`, body: `Don't break it now${name} — you were so consistent!` },
      { title: "Streak alert 🔔", body: `${streakDays} days in a row — open the app today to keep it going!` },
      { title: "Complete today's streak 🌟", body: `${streakDays}-day productivity streak. One tap to keep it alive!` },
    ]);
  }

  // ── overdue heavy ────────────────────────────────────────────────────────────
  if (overdueCount >= 5) {
    return pick<Template>([
      { title: `🚨 SOS${name}`, body: `${overdueCount} overdue reminders are screaming for attention. Maybe now? 🙈` },
      { title: "Houston, we have a problem 🛸", body: `${overdueCount} overdue tasks and counting. Time to face the music!` },
      { title: "Your tasks filed a complaint 📣", body: `${overdueCount} overdue. Your future self is judging you 😬` },
      { title: "Code red 🔴", body: `${overdueCount} overdue reminders. But honestly… today's a great day to clear them!` },
    ]);
  }

  if (overdueCount >= 2) {
    return pick<Template>([
      { title: `⏰ Hey${name}, come back!`, body: `${overdueCount} reminders are overdue. ${pendingCount - overdueCount} more waiting!` },
      { title: "Your tasks miss you 🥺", body: `${overdueCount} overdue + ${pendingCount - overdueCount} upcoming. Still totally saveable!` },
    ]);
  }

  // ── long inactivity (3+ days) ────────────────────────────────────────────────
  if (daysInactive >= 5) {
    return pick<Template>([
      { title: `Day ${days} without the app 👻`, body: `Your ${pendingCount} tasks are still there, patiently waiting...` },
      { title: `Long time no see${name} 🙁`, body: `${pendingCount} tasks collecting dust. Come back, we miss you!` },
      { title: "Plot twist 📱", body: `The app still works. ${pendingCount} things need your 2 minutes 😅` },
      { title: "Missing person alert 🔍", body: `It's been ${days} days${name}. Your tasks are putting up posters 😂` },
    ]);
  }

  if (daysInactive >= 3) {
    return pick<Template>([
      { title: `Still here${name} 👋`, body: `${pendingCount} tasks haven't moved since you left. Miss us?` },
      { title: "Your goals called 📞", body: `They said: come back, ${pendingCount} things still need your attention 💪` },
      { title: "3 days, zero tasks done 📊", body: `But it's never too late${name}. ${pendingCount} pending and ready for you!` },
    ]);
  }

  if (daysInactive >= 2) {
    return pick<Template>([
      { title: `Missed you yesterday${name} 👀`, body: `${pendingCount} reminders are getting lonely without you!` },
      { title: "Bro, check your tasks 🙃", body: `${pendingCount} things waiting. Took 2 mins to create, takes 2 mins to check!` },
      { title: "Your streak is at risk ⚡", body: `Don't break the momentum — ${pendingCount} tasks to clear today!` },
      { title: "Productivity check 📋", body: `${pendingCount} pending. You've done it before, you can do it now!` },
    ]);
  }

  // ── Types 1/3/5/6/8/9: AI engagement for users with no pending reminders ─────
  // This fires for active users who have cleared their task list — keep them engaged.
  // Also fires for re-engagement when the user has nothing pending.
  if (hasNoPending) {
    if (slot === "morning") {
      return pick<Template>([
        { title: `Good morning${name} ☀️`, body: "Need help planning your day? Just ask MYSA." },
        { title: "MYSA is ready for today ✨", body: "What shall we tackle together? Open the app and ask anything." },
        { title: "Start your day strong 🚀", body: "Tell MYSA your goals — get an instant action plan back." },
        { title: "AI tip of the day 📚", body: `Try: "What should I focus on today?" — MYSA will prioritize for you.` },
        { title: "Good morning! Want today's plan? 🌅", body: "Open MYSA and describe your day — get a clear action list instantly." },
      ]);
    }
    if (slot === "afternoon") {
      return pick<Template>([
        { title: "Need help writing faster? ✍️", body: "MYSA can draft emails, replies, and messages in seconds — try it!" },
        { title: "Quick productivity trick ⚡", body: "Ask MYSA to break your biggest challenge into small, clear steps." },
        { title: "Your AI assistant is ready 🤖", body: "Turn any rough note into a structured plan — open MYSA and paste it." },
        { title: "Afternoon check-in 💡", body: "What's on your plate? MYSA can help you prioritize and plan ahead." },
      ]);
    }
    if (slot === "evening") {
      return pick<Template>([
        { title: `Evening wrap-up${name} 🌆`, body: "Need help summarizing your day or planning tomorrow?" },
        { title: "Plan tomorrow tonight 🌙", body: "Ask MYSA what to tackle first tomorrow — your future self will thank you!" },
        { title: "5 mins now = smooth tomorrow 🌇", body: "Tell MYSA what's ahead — get a clean game plan before you wind down." },
        { title: "Need help summarizing your day? 🌆", body: "Open MYSA and describe your day — get a clean summary + next steps." },
      ]);
    }
    // Generic AI engagement (Type 1, 3, 6, 8, 9 mixed)
    return pick<Template>([
      { title: `Hey${name}, MYSA misses you 🤖`, body: "Your AI assistant is ready whenever you are — just open the app!" },
      { title: "One small productive step today? 🌱", body: "Even small actions compound. Open MYSA and share what's on your mind." },
      { title: "Did you know? 💡", body: "You can create reminders just by describing them in plain English — try it!" },
      { title: "Try today's AI prompt 🎯", body: `"What should I focus on this week?" — ask MYSA and get a smart plan instantly.` },
      { title: "AI tip of the day 📚", body: `"Remind me to follow up with [person] next Monday" — just say it, MYSA handles the rest.` },
      { title: "Feeling overwhelmed? 💙", body: "Let's organize things together. Open MYSA and tell it what's weighing on you." },
      { title: "How can I help today? 🤖✨", body: "Your AI assistant is standing by. Ask anything — plans, reminders, drafts, ideas." },
      { title: "Generate a quick to-do list ✅", body: "Tell MYSA everything on your mind — it'll turn it into a clean to-do list." },
      { title: "Unlock more with Pro ✨", body: "Unlimited AI chats + advanced models. Upgrade and supercharge your productivity." },
    ]);
  }

  // ── domain focus (if there's a clear top domain) ─────────────────────────────
  if (topDomain && label) {
    return pick<Template>([
      { title: `${emoji} Your ${label} game`, body: `${pendingCount} tasks pending. You were SO close to a clean slate!` },
      { title: `${emoji} ${label.charAt(0).toUpperCase() + label.slice(1)} check-in`, body: `${pendingCount} things to tick off. The ${label} version of you agrees!` },
      { title: `Remember the plan?${name}`, body: `Your ${label} goals: ${pendingCount} tasks strong. Let's go! ${emoji}` },
    ]);
  }

  // ── next due personalisation ─────────────────────────────────────────────────
  if (nextDueTitle) {
    return pick<Template>([
      { title: "⏳ Coming up soon", body: `"${nextDueTitle}" is on the horizon. Don't let it sneak up!` },
      { title: "Heads up! 👆", body: `"${nextDueTitle}" needs your attention + ${pendingCount - 1} more.` },
    ]);
  }

  // ── time-of-day contextual ────────────────────────────────────────────────────
  if (slot === "morning") {
    return pick<Template>([
      { title: `Rise and grind${name} ☀️`, body: `${pendingCount} tasks, ${slot} energy. Crush them before lunch!` },
      { title: "Good morning! 🌅", body: `Starting strong? You've got ${pendingCount} things to tackle today!` },
      { title: "Morning fuel ☕", body: `Before the chai gets cold — ${pendingCount} quick tasks are waiting!` },
      { title: "Monday mindset activated 💡", body: `${pendingCount} tasks. New ${slot}, new wins. Let's go!` },
    ]);
  }

  if (slot === "afternoon") {
    return pick<Template>([
      { title: "Afternoon slump? 😴", body: `${pendingCount} tasks as your perfect pick-me-up. You'll feel great after! 💪` },
      { title: "2 PM energy check 🔋", body: `Still ${pendingCount} tasks on the list. Now's the perfect window!` },
      { title: "Post-lunch productivity 🍽️", body: `${pendingCount} tasks. Afternoon focus hits different 🎯` },
    ]);
  }

  if (slot === "evening") {
    return pick<Template>([
      { title: `Evening wrap-up 🌆`, body: `${pendingCount} tasks before you log off for the day?` },
      { title: `End the day strong${name} 💯`, body: `${pendingCount} tasks. Clear them tonight, sleep better tomorrow!` },
      { title: "Golden hour 🌇", body: `${pendingCount} reminders left. End your day with a big ✅!` },
    ]);
  }

  // ── generic fallback (mixes re-engagement + AI engagement + feature discovery) ─
  return pick<Template>([
    { title: `Hey${name}, you there? 👋`, body: `${pendingCount} tasks haven't seen you in a while!` },
    { title: "Your to-do list is lonely 🥺", body: `Come back and cross off ${pendingCount} things!` },
    { title: "Quick check-in 📋", body: `${pendingCount} pending. A minute could clear the queue ✅` },
    { title: "Just a nudge 😊", body: `${pendingCount} reminders waiting. No pressure… but also, kinda 👀` },
    { title: `1 tap, ${pendingCount} tasks 🎯`, body: `Open the app and let's knock them out together!` },
    // Type 3: AI productivity suggestions
    { title: "Your AI assistant is waiting 🤖", body: `${pendingCount} tasks pending — want MYSA to help you prioritize them?` },
    { title: "Work smarter, not harder ⚡", body: `Ask MYSA to organize your ${pendingCount} pending tasks by priority.` },
    // Type 6: Feature discovery
    { title: "Pro tip 💡", body: `You can ask MYSA to reschedule all your tasks just by describing the change.` },
    { title: "Did you know? ✨", body: `MYSA can group your ${pendingCount} tasks by category and suggest which to do first.` },
    // Type 8: Emotional/companion
    { title: "We haven't seen you in a while 👀", body: `${pendingCount} things waiting. Your AI assistant misses helping you!` },
    { title: "Feeling overwhelmed? 💙", body: `${pendingCount} tasks, but no worries — let's tackle them together, one step at a time.` },
  ]);
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

        // ── 1e. Streak calculation from recent events ───────────────────────────
        let streakDays = 0;
        try {
          const recentEvents = await client.query(api.userEvents.getRecent, { userId, limitDays: 30 });
          const activeDays = new Set<string>();
          for (const e of recentEvents) {
            const d = new Date(e.createdAt);
            activeDays.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
          }
          // Count consecutive days ending yesterday (today the user is inactive).
          for (let i = 1; i <= 30; i++) {
            const d = new Date(now - i * 86_400_000);
            const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
            if (!activeDays.has(key)) break;
            streakDays++;
          }
        } catch { /* non-critical — default 0 */ }

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
          displayName:   meta.displayName,
          localHour,
          streakDays,
          hasNoPending:  stats.pendingCount === 0,
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
