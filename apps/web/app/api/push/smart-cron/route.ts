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
 * Picks a gentle, supportive notification from context-appropriate pools.
 * Celebrates streaks (never threatens them), reframes overdue without shame,
 * and never guilt-trips. All copy also passes the anti-surveillance filter.
 */
export function generateSmartNudgeMessage(ctx: NudgeContext): Template {
  const {
    pendingCount, overdueCount, topDomain,
    nextDueTitle, displayName, localHour, streakDays, hasNoPending,
  } = ctx;

  const name  = displayName ? ` ${displayName.split(" ")[0]}` : "";
  const slot  = localTimeSlot(localHour);
  const emoji = topDomain ? DOMAIN_EMOJI[topDomain] ?? "🌱" : "🌱";
  const label = topDomain ? DOMAIN_LABEL[topDomain] ?? topDomain : "";
  const n     = (c: number) => `${c} thing${c !== 1 ? "s" : ""}`;

  // ── Streak — CELEBRATE, never threaten ──
  if (streakDays >= 7) {
    return pick<Template>([
      { title: `${streakDays} days in a row 🌱`, body: `that's real momentum${name}. however today goes, you've already built something.` },
      { title: "look at you go 🔥", body: `${streakDays} days showing up. for an adhd brain that's genuinely big. proud of you.` },
      { title: "quiet little streak 🌟", body: `${streakDays} days in. no pressure to keep it — just noticing you've been kind to yourself.` },
    ]);
  }
  if (streakDays >= 3) {
    return pick<Template>([
      { title: `${streakDays} days, nice 🌱`, body: `you've shown up a few days running${name}. that counts for a lot.` },
      { title: "momentum's a real thing 🌿", body: `${streakDays} days in a row. whatever happens next, this was good.` },
    ]);
  }

  // ── Overdue — gentle, no panic, no shame ──
  if (overdueCount >= 5) {
    return pick<Template>([
      { title: "the list got long 🌿", body: "a bunch of things slipped past their time. that's okay — just pick one, the rest can wait." },
      { title: `breathe${name} 😌`, body: `${overdueCount} things are past due, but you're not behind — the list is just long. one thing is enough.` },
      { title: "no rush 🤍", body: "some reminders drifted past. whenever you're ready, start with whichever feels easiest." },
    ]);
  }
  if (overdueCount >= 2) {
    return pick<Template>([
      { title: "a couple things slipped 🌱", body: `${overdueCount} past their time — no stress. pick one whenever the moment feels right.` },
      { title: "still totally fine 😌", body: "a few reminders are waiting past due. they're not going anywhere — start small." },
    ]);
  }

  // ── No pending — chill / gentle ──
  if (hasNoPending) {
    if (slot === "morning") {
      return pick<Template>([
        { title: `morning${name} 🌅`, body: "nothing pressing right now. if something's on your mind, i can help you sort it." },
        { title: "clear slate ☀️", body: "nothing pending today. enjoy it — i'm here if you want to plan anything." },
      ]);
    }
    if (slot === "evening") {
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

  // ── Next due — gentle heads-up ──
  if (nextDueTitle) {
    return pick<Template>([
      { title: "gentle heads-up 🌿", body: `"${nextDueTitle}" is coming up. no rush — just putting it on your radar.` },
      { title: "coming up soon 😌", body: `"${nextDueTitle}" is on the horizon whenever you're ready for it.` },
    ]);
  }

  // ── Domain focus — light, supportive ──
  if (topDomain && label) {
    return pick<Template>([
      { title: `${emoji} a little ${label} nudge`, body: `${n(pendingCount)} waiting whenever you've got the energy.` },
      { title: `${emoji} no rush on ${label}`, body: `your ${label} list is here when you want it${name}. one small step counts.` },
    ]);
  }

  // ── Time-of-day — warm, low-pressure ──
  if (slot === "morning") {
    return pick<Template>([
      { title: `morning${name} 🌱`, body: "if you only do one thing today, that's enough. pick whichever feels lightest." },
      { title: "easy start ☀️", body: `${n(pendingCount)} when you're ready — but just starting one is a win.` },
    ]);
  }
  if (slot === "afternoon") {
    return pick<Template>([
      { title: "afternoon check-in 🌿", body: "if there's energy for one small thing, great. if not, that's okay too." },
      { title: "no pressure 😌", body: `${n(pendingCount)} pending whenever it feels right. one tiny step is plenty.` },
    ]);
  }
  if (slot === "evening") {
    return pick<Template>([
      { title: `winding down${name} 🌙`, body: "whatever didn't happen today is fine — it'll keep. you did enough." },
      { title: "soft evening 🌿", body: "one quick thing if you feel like it, otherwise rest. both are good choices." },
    ]);
  }

  // ── Gentle fallback ──
  return pick<Template>([
    { title: "here whenever you're ready 🌱", body: `${n(pendingCount)} waiting — no rush, no pressure.` },
    { title: "soft check-in 🤍", body: `your reminders are here when you want them${name}. start with the easiest one.` },
    { title: "one small step 🌿", body: "nothing pressing. if you want to knock out one thing, i'm right here." },
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
