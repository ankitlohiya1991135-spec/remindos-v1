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

const INACTIVITY_THRESHOLD_MS = 24 * 60 * 60_000;  // user must be away 24 h+
const DEDUP_WINDOW_MS          = 23 * 60 * 60_000;  // max 1 nudge per 23 h
const QUIET_START_HOUR         = 22;                 // 10 PM local time
const QUIET_END_HOUR           = 8;                  // 8  AM local time

// ── quiet-hours helper ─────────────────────────────────────────────────────────

/**
 * Returns true if `now` falls inside quiet hours for the given IANA timezone.
 * Quiet window: QUIET_START_HOUR → QUIET_END_HOUR (wraps midnight).
 */
function isQuietHours(timeZone = "Asia/Kolkata"): boolean {
  try {
    const localHour = parseInt(
      new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        hour12: false,
        timeZone,
      }).format(new Date()),
      10,
    );
    // Window wraps midnight (e.g. 22 → 8).
    return localHour >= QUIET_START_HOUR || localHour < QUIET_END_HOUR;
  } catch {
    // Invalid TZ string — fall back to UTC heuristic.
    const h = new Date().getUTCHours();
    return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
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
    nextDueTitle, displayName, localHour,
  } = ctx;

  const name  = displayName ? `, ${displayName.split(" ")[0]}` : "";
  const slot  = localTimeSlot(localHour);
  const days  = Math.round(daysInactive);
  const emoji = topDomain ? DOMAIN_EMOJI[topDomain] ?? "📌" : "";
  const label = topDomain ? DOMAIN_LABEL[topDomain] ?? topDomain : "";

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

  // ── generic fallback ─────────────────────────────────────────────────────────
  return pick<Template>([
    { title: `Hey${name}, you there? 👋`, body: `${pendingCount} tasks haven't seen you in a while!` },
    { title: "Your to-do list is lonely 🥺", body: `Come back and cross off ${pendingCount} things!` },
    { title: "Quick check-in 📋", body: `${pendingCount} pending. A minute could clear the queue ✅` },
    { title: "Just a nudge 😊", body: `${pendingCount} reminders waiting. No pressure… but also, kinda 👀` },
    { title: "1 tap, ${pendingCount} tasks 🎯", body: `Open the app and let's knock them out together!` },
  ]);
}

// ── GET: health check ──────────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}

// ── POST: cron worker ──────────────────────────────────────────────────────────
export async function POST(request: Request) {
  // Verify cron secret.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const client = getConvexClient();
  const now = Date.now();
  const results = { sent: 0, skipped_active: 0, skipped_quiet: 0, skipped_dedup: 0, skipped_empty: 0, errors: 0 };

  try {
    // ── 1. Get all subscriptions (we filter in-memory for smartNudgeEnabled) ────
    const allSubs = await client.query(api.pushSubscriptions.listAllUsers, {});

    // Build: userId → { timeZone, displayName } — take first match per user.
    const userMeta = new Map<string, { timeZone?: string; displayName?: string }>();
    for (const sub of allSubs) {
      if (!sub.smartNudgeEnabled) continue;
      if (!userMeta.has(sub.userId)) {
        userMeta.set(sub.userId, { timeZone: sub.timeZone, displayName: sub.displayName });
      }
    }

    const userIds = [...userMeta.keys()];

    for (const userId of userIds) {
      try {
        const meta = userMeta.get(userId)!;
        const tz = meta.timeZone ?? "Asia/Kolkata";

        // ── 1a. Quiet hours check ───────────────────────────────────────────────
        if (isQuietHours(tz)) {
          results.skipped_quiet += 1;
          continue;
        }

        // ── 1b. Inactivity check ────────────────────────────────────────────────
        const lastSeenAt = await client.query(api.userSessions.getLastSeenAt, { userId });
        const msSinceActive = lastSeenAt ? now - lastSeenAt : Infinity;
        if (msSinceActive < INACTIVITY_THRESHOLD_MS) {
          results.skipped_active += 1;
          continue;
        }
        const daysInactive = msSinceActive / 86_400_000;

        // ── 1c. Dedup — max 1 nudge per 23 h ────────────────────────────────────
        if (await alreadySentSmartNudge(client, userId)) {
          results.skipped_dedup += 1;
          continue;
        }

        // ── 1d. Reminder stats ───────────────────────────────────────────────────
        const stats = await client.query(api.reminders.getSmartNudgeStats, { userId });
        if (stats.pendingCount === 0) {
          results.skipped_empty += 1;
          continue;
        }

        // ── 1e. Build message ───────────────────────────────────────────────────
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
        });

        // ── 1f. Send push ───────────────────────────────────────────────────────
        await sendWebPushToUser(userId, {
          type: "smart_nudge",
          title,
          body,
          pendingCount: stats.pendingCount,
          overdueCount: stats.overdueCount,
        });

        await recordSmartNudge(client, userId);

        // Persist in notification centre so user sees it even if they miss the push.
        await client.mutation(api.notifications.create, {
          userId,
          type: "smart_nudge",
          title,
          body,
        });

        results.sent += 1;
      } catch {
        results.errors += 1;
      }
    }
  } catch (err) {
    console.error("[push/smart-cron] fatal error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, results, ts: new Date(now).toISOString() });
}
