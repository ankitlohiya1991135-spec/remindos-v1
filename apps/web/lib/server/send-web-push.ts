import webpush from "web-push";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "./convex-client";

let configured = false;

export function initWebPush(): boolean {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:reminders@localhost";
  if (!pub || !priv) {
    console.error(
      "[push] VAPID keys not configured. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and " +
      "VAPID_PRIVATE_KEY in Vercel environment variables. Push notifications are disabled."
    );
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export async function sendWebPushToUser(userId: string, payload: Record<string, unknown>): Promise<number> {
  if (!initWebPush()) {
    console.error(`[push] Skipping push for user ${userId} — VAPID not configured.`);
    return 0;
  }
  const client = getConvexClient();
  const subs = await client.query(api.pushSubscriptions.listForUser, { userId });
  if (subs.length === 0) {
    console.warn(`[push] No push subscriptions found for user ${userId}. User needs to enable push in app settings.`);
    return 0;
  }
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        },
        body,
        { urgency: "high", TTL: 86_400 }
      );
      sent += 1;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error(`[push] Failed to send to user ${userId} endpoint (HTTP ${status ?? "?"}): ${msg}`);
      if (status === 404 || status === 410) {
        // Subscription expired — remove it so we don't keep trying
        try {
          await client.mutation(api.pushSubscriptions.removePushSubscription, {
            userId,
            endpoint: s.endpoint,
          });
          console.warn(`[push] Removed expired subscription for user ${userId}`);
        } catch {
          /* ignore */
        }
      }
    }
  }
  console.log(`[push] Sent ${sent}/${subs.length} notifications for user ${userId} type=${payload.type ?? "unknown"}`);
  return sent;
}
