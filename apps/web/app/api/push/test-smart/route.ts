/**
 * /api/push/test-smart — send a test smart nudge to the currently logged-in user.
 *
 * Bypasses ALL inactivity / quiet-hours / dedup checks so the notification
 * pipeline can be verified end-to-end at any time.
 *
 * POST — no body needed. Reads userId from Clerk session.
 * Returns: { ok, sent, title, body, diagnostics }
 */

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { sendWebPushToUser } from "../../../../lib/server/send-web-push";
import { generateSmartNudgeMessage } from "../smart-cron/route";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const vapidOk = !!(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  );

  const client = getConvexClient();

  // Check subscriptions
  const subs = await client.query(api.pushSubscriptions.listForUser, { userId });

  const diagnostics = {
    vapidOk,
    subscriptionsFound: subs.length,
    userId,
    tip: !vapidOk
      ? "VAPID keys missing — add NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to Vercel env vars"
      : subs.length === 0
      ? "No push subscriptions — open app settings and toggle Push Notifications off then on again"
      : "All good — notification should arrive shortly",
  };

  if (!vapidOk || subs.length === 0) {
    return NextResponse.json({ ok: false, sent: 0, diagnostics }, { status: 200 });
  }

  // Build a test message
  const now = Date.now();
  const localHour = new Date(now).getHours();
  let pendingCount = 0, overdueCount = 0;
  let topDomain: string | null = null, nextDueTitle: string | null = null;
  try {
    const stats = await client.query(api.reminders.getSmartNudgeStats, { userId });
    pendingCount  = stats.pendingCount;
    overdueCount  = stats.overdueCount;
    topDomain     = stats.topDomain ?? null;
    nextDueTitle  = stats.nextDueTitle ?? null;
  } catch { /* non-critical */ }

  const { title, body } = await generateSmartNudgeMessage({
    daysInactive: 1,          // pretend user was away 1 day for a realistic message
    pendingCount,
    overdueCount,
    topDomain,
    nextDueTitle,
    displayName: null,
    localHour,
    streakDays: 0,
    hasNoPending: pendingCount === 0,
  });

  const sent = await sendWebPushToUser(userId, {
    type: "smart_nudge",
    title,
    body,
    test: true,
  });

  // Also persist in notification centre
  if (sent > 0) {
    await client.mutation(api.notifications.create, {
      userId,
      type: "smart_nudge",
      title: `[TEST] ${title}`,
      body,
    });
  }

  return NextResponse.json({
    ok: true,
    sent,
    title,
    body,
    diagnostics,
  });
}
