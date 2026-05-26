/**
 * /api/push/cron — called by Vercel Cron every minute.
 *
 * Handles four notification types:
 *  1. due_reminder      — fires when a reminder's dueAt is within the current minute
 *  2. pre_due_reminder  — fires 15 minutes before dueAt (configurable via PRE_DUE_MINUTES)
 *  3. overdue_nudge     — hourly nudge for reminders 1–24 h overdue (fires once per reminder)
 *  4. morning_briefing  — daily digest at the user's configured hour (default 8 am UTC)
 *
 * Security: requests must carry the CRON_SECRET header matching the env var.
 */

import { NextResponse } from "next/server";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { sendWebPushToUser } from "../../../../lib/server/send-web-push";

/** Global fallback — used when a subscription has no per-user preference stored. */
const DEFAULT_PRE_DUE_MINUTES = Number(process.env.PRE_DUE_MINUTES ?? "15");

// ── helpers ────────────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

/**
 * Returns true if we already sent a push of `type` for `reminderId` within
 * the last `windowMs` milliseconds.  Uses the pushNotificationLogs Convex table.
 */
async function alreadySent(
  client: ReturnType<typeof getConvexClient>,
  userId: string,
  type: string,
  reminderId: string | undefined,
  windowMs: number,
): Promise<boolean> {
  const rows = await client.query(api.pushNotificationLogs.listRecentForUser, {
    userId,
    type,
    sinceMs: windowMs,
  });
  if (!reminderId) return rows.length > 0;
  return rows.some((r) => r.reminderId === reminderId);
}

async function recordSent(
  client: ReturnType<typeof getConvexClient>,
  userId: string,
  type: string,
  reminderId?: string,
) {
  await client.mutation(api.pushNotificationLogs.logSent, {
    userId,
    type,
    reminderId,
    sentAt: nowMs(),
  });
}

async function saveNotification(
  client: ReturnType<typeof getConvexClient>,
  userId: string,
  type: string,
  title: string,
  body: string,
  reminderId?: string,
) {
  await client.mutation(api.notifications.create, {
    userId,
    type,
    title,
    body,
    reminderId,
  });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

// ── GET: health check + diagnostics ───────────────────────────────────────────
export async function GET() {
  const vapidConfigured = !!(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  );
  const cronSecretSet = !!process.env.CRON_SECRET;

  let subscriptionCount = 0;
  try {
    const client = getConvexClient();
    const subs = await client.query(api.pushSubscriptions.listAllUsers, {});
    subscriptionCount = subs.length;
  } catch { /* ignore */ }

  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    diagnostics: {
      vapidConfigured,
      cronSecretSet,
      subscriptionCount,
      note: "POST /api/push/cron requires Authorization: Bearer <CRON_SECRET> header",
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
      console.warn(`[push/cron] 401 unauthorized — auth header present=${!!authHeader}, query secret present=${!!querySecret}`);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const client = getConvexClient();
  const now = nowMs();
  const results = { due: 0, preDue: 0, overdue: 0, briefing: 0, errors: 0 };

  // Check VAPID up-front so the log shows the problem immediately
  const vapidOk = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (!vapidOk) {
    console.error("[push/cron] VAPID keys missing — no push notifications will be sent. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel env vars.");
  }

  try {
    // ── 1. Collect all users with active push subscriptions ───────────────────
    // Build a per-user map: userId → max(preDueMinutes) across all their devices.
    // This ensures a user with "30 min" on one device still gets a 30-min push.
    const allSubs = await client.query(api.pushSubscriptions.listAllUsers, {});
    const userPreDueMap = new Map<string, number>();
    for (const sub of allSubs) {
      const minutes = sub.preDueMinutes ?? DEFAULT_PRE_DUE_MINUTES;
      const current = userPreDueMap.get(sub.userId) ?? 0;
      if (minutes > current) userPreDueMap.set(sub.userId, minutes);
    }
    const userIds = [...userPreDueMap.keys()];
    console.log(`[push/cron] tick — ${userIds.length} subscribed users, vapidOk=${vapidOk}, utc=${new Date(now).toISOString()}`);

    // Fetch reminders up to the widest pre-due window any user has.
    const maxPreDueMinutes = userIds.length > 0
      ? Math.max(...userIds.map((id) => userPreDueMap.get(id) ?? DEFAULT_PRE_DUE_MINUTES))
      : DEFAULT_PRE_DUE_MINUTES;
    // 3-minute lookback: if cron-job.org skips one cycle the reminder is still caught
    // on the next fire without needing a perfect every-60-s schedule.
    const windowStart = now - 3 * 60_000;
    const windowEnd = now + (maxPreDueMinutes + 1) * 60_000;

    for (const userId of userIds) {
      try {
        // Per-user pre-due preference (with global fallback).
        const userPreDueMinutes = userPreDueMap.get(userId) ?? DEFAULT_PRE_DUE_MINUTES;
        const reminders = await client.query(api.reminders.listForCron, {
          userId,
          statusFilter: "pending",
          dueAtFrom: windowStart,
          dueAtTo: windowEnd,
        });

        for (const reminder of reminders) {
          const dueAt = reminder.dueAt;

          // ── 1a. due_reminder: dueAt within 3-minute lookback window ─────────
          // 3-minute lookback means a skipped cron cycle never silently drops a
          // notification. Dedup window is 5 min so each reminder fires at most once.
          if (dueAt >= now - 3 * 60_000 && dueAt <= now + 60_000) {
            const sent = await alreadySent(client, userId, "due_reminder", reminder._id, 5 * 60_000);
            if (!sent) {
              const payload = {
                type: "due_reminder",
                reminderId: reminder._id,
                title: reminder.title,
                body: reminder.notes ? `${reminder.notes}` : "Tap to open",
                dueAt,
              };
              await sendWebPushToUser(userId, payload);
              await recordSent(client, userId, "due_reminder", reminder._id);
              await saveNotification(client, userId, "due_reminder",
                reminder.title, `Due now — ${formatTime(dueAt)}`, reminder._id);
              results.due += 1;
            }
          }

          // ── 1b. pre_due_reminder: fires userPreDueMinutes before dueAt ───────
          if (userPreDueMinutes > 0) {
            const preDueWindow = userPreDueMinutes * 60_000;
            if (dueAt >= now + preDueWindow - 60_000 && dueAt <= now + preDueWindow + 60_000) {
              const sent = await alreadySent(client, userId, "pre_due_reminder", reminder._id, 20 * 60_000);
              if (!sent) {
                const payload = {
                  type: "pre_due_reminder",
                  reminderId: reminder._id,
                  title: reminder.title,
                  body: `Due in ${userPreDueMinutes} minutes (${formatTime(dueAt)})`,
                  dueAt,
                };
                await sendWebPushToUser(userId, payload);
                await recordSent(client, userId, "pre_due_reminder", reminder._id);
                await saveNotification(client, userId, "pre_due_reminder",
                  reminder.title, `Due in ${userPreDueMinutes} min — ${formatTime(dueAt)}`, reminder._id);
                results.preDue += 1;
              }
            }
          }
        }

        // ── 1c. overdue_nudge: reminders 1–24h overdue ────────────────────────
        const overdueReminders = await client.query(api.reminders.listForCron, {
          userId,
          statusFilter: "pending",
          dueAtFrom: now - 24 * 60 * 60_000,
          dueAtTo: now - 60 * 60_000,   // at least 1h overdue
        });

        if (overdueReminders.length > 0) {
          const sent = await alreadySent(client, userId, "overdue_nudge", undefined, 60 * 60_000);
          if (!sent) {
            const titles = overdueReminders.slice(0, 3).map((r) => r.title).join(", ");
            const extra = overdueReminders.length > 3 ? ` +${overdueReminders.length - 3} more` : "";
            const payload = {
              type: "overdue_nudge",
              count: overdueReminders.length,
              titles: overdueReminders.slice(0, 3).map((r) => r.title),
              body: `${overdueReminders.length} overdue: ${titles}${extra}`,
            };
            await sendWebPushToUser(userId, payload);
            await recordSent(client, userId, "overdue_nudge", undefined);
            await saveNotification(client, userId, "overdue_nudge",
              `${overdueReminders.length} overdue reminder${overdueReminders.length !== 1 ? "s" : ""}`,
              `${titles}${extra}`);
            results.overdue += 1;
          }
        }

        // ── 1d. morning_briefing: once per day at user's configured UTC hour ──
        // Per-user hour comes from their push subscription; falls back to
        // MORNING_BRIEFING_HOUR_UTC env var, then to 2 (= 7:30 AM IST).
        const utcHour = new Date(now).getUTCHours();
        const utcMinute = new Date(now).getUTCMinutes();
        const subForUser = allSubs.find((s) => s.userId === userId);
        const briefingHour = subForUser?.morningBriefingHourUtc
          ?? Number(process.env.MORNING_BRIEFING_HOUR_UTC ?? "2");
        if (utcHour === briefingHour && utcMinute < 2) {
          const sent = await alreadySent(client, userId, "morning_briefing", undefined, 23 * 60 * 60_000);
          if (!sent) {
            const allPending = await client.query(api.reminders.listForCron, {
              userId,
              statusFilter: "pending",
              dueAtFrom: now,
              dueAtTo: now + 24 * 60 * 60_000,
            });
            const count = allPending.length;
            if (count > 0) {
              const titles = allPending.slice(0, 3).map((r) => r.title).join(", ");
              const extra = count > 3 ? ` +${count - 3} more` : "";
              const payload = {
                type: "morning_briefing",
                count,
                body: `Good morning! You have ${count} reminder${count !== 1 ? "s" : ""} today: ${titles}${extra}`,
              };
              await sendWebPushToUser(userId, payload);
              await recordSent(client, userId, "morning_briefing", undefined);
              await saveNotification(client, userId, "morning_briefing",
                `Good morning — ${count} reminder${count !== 1 ? "s" : ""} today`,
                `${titles}${extra}`);
              results.briefing += 1;
            }
          }
        }
      } catch {
        results.errors += 1;
      }
    }

    // Periodic log pruning (runs ~every 10 min to avoid hammering Convex)
    if (new Date(now).getUTCMinutes() % 10 === 0) {
      await client.mutation(api.pushNotificationLogs.pruneOld, {}).catch(() => {});
    }
  } catch (err) {
    console.error("[push/cron] fatal error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, results, ts: new Date(now).toISOString() });
}
