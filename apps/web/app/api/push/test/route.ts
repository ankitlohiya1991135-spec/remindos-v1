/**
 * /api/push/test — Sends a test push notification to the calling user.
 *
 * Used by the app settings to verify the full push pipeline:
 *   service-worker registered → subscription saved → VAPID configured → push delivered
 *
 * Returns a structured response so the UI can show the user exactly what failed.
 */

import { auth } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { initWebPush } from "../../../../lib/server/send-web-push";
import webpush from "web-push";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }

  // 1. Check VAPID is configured
  const vapidReady = initWebPush();
  if (!vapidReady) {
    return NextResponse.json({
      ok: false,
      step: "vapid",
      error: "VAPID keys not configured on server. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel environment variables.",
    });
  }

  // 2. Check the user has at least one push subscription saved
  const client = getConvexClient();
  const subs = await client.query(api.pushSubscriptions.listForUser, { userId });
  if (subs.length === 0) {
    return NextResponse.json({
      ok: false,
      step: "subscription",
      error: "No push subscription found for your account. Make sure you've enabled Push Notifications in the app settings and the permission was granted in your browser.",
    });
  }

  // 3. Send a test push to each of the user's subscriptions
  const payload = JSON.stringify({
    type: "due_reminder",
    title: "Test notification 🎉",
    body: "Push notifications are working! You'll receive due-time reminders like this.",
    reminderId: "test",
  });

  let sent = 0;
  let lastError: string | null = null;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: "high", TTL: 60 },
      );
      sent += 1;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      const msg = (err as { message?: string })?.message ?? String(err);

      // 404/410 = subscription expired — clean it up
      if (status === 404 || status === 410) {
        await client
          .mutation(api.pushSubscriptions.removePushSubscription, {
            userId,
            endpoint: sub.endpoint,
          })
          .catch(() => {});
        lastError = "Your push subscription has expired. Toggle Push Notifications off and on again in app settings to re-register.";
      } else if (status === 401) {
        lastError = "VAPID key mismatch. The public/private VAPID keys on the server don't match the ones used when you subscribed. Toggle Push Notifications off and on to re-subscribe with the current keys.";
      } else {
        lastError = `Push delivery failed (HTTP ${status ?? "?"}) — ${msg}`;
      }
    }
  }

  if (sent > 0) {
    return NextResponse.json({ ok: true, sent, total: subs.length });
  }

  return NextResponse.json({
    ok: false,
    step: "delivery",
    error: lastError ?? "Failed to deliver notification. Check server logs.",
    total: subs.length,
  });
}
