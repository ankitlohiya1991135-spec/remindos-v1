/**
 * Sync Web Push subscription with the server (requires Notification permission + SW).
 * Used for share-invite alerts when the PWA is in the background (Android/desktop; iOS PWAs vary).
 */

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function syncReminderPushSubscription(preDueMinutes?: number): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return false;
  }
  if (Notification.permission !== "granted") return false;
  try {
    const res = await fetch("/api/push/vapid-public");
    const data = (await res.json()) as { publicKey: string | null; configured?: boolean };
    if (!data.configured || !data.publicKey) return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey),
      });
    }
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return false;
    const save = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: j.endpoint,
        keys: { p256dh: j.keys.p256dh, auth: j.keys.auth },
        ...(preDueMinutes !== undefined ? { preDueMinutes } : {}),
      }),
    });
    return save.ok;
  } catch {
    return false;
  }
}
