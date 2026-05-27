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

/** Returns true when two ArrayBuffers contain identical bytes. */
function arrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

export async function syncReminderPushSubscription(
  preDueMinutes?: number,
  smartNudgeEnabled?: boolean,
  morningBriefingHourUtc?: number,
  quietStartHour?: number,
  quietEndHour?: number,
): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return false;
  }
  if (Notification.permission !== "granted") return false;
  try {
    const res = await fetch("/api/push/vapid-public");
    const data = (await res.json()) as { publicKey: string | null; configured?: boolean };
    if (!data.configured || !data.publicKey) return false;
    const currentKeyBytes = urlBase64ToUint8Array(data.publicKey);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Check if the existing subscription was made with the current VAPID key.
      // If the key changed (e.g. new VAPID pair was generated) the subscription
      // will return 401/403 from FCM and must be replaced.
      const existingKeyBuffer = (sub.options as { applicationServerKey?: ArrayBuffer | null }).applicationServerKey;
      const keyMismatch = !existingKeyBuffer || !arrayBuffersEqual(existingKeyBuffer, currentKeyBytes.buffer);
      if (keyMismatch) {
        console.warn("[push] VAPID key mismatch — unsubscribing and re-subscribing");
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: currentKeyBytes,
      });
    }
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return false;

    // Capture IANA timezone for quiet-hour checks on the server.
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch { /* ignore */ }

    const save = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: j.endpoint,
        keys: { p256dh: j.keys.p256dh, auth: j.keys.auth },
        ...(preDueMinutes !== undefined ? { preDueMinutes } : {}),
        ...(smartNudgeEnabled !== undefined ? { smartNudgeEnabled } : {}),
        ...(timeZone !== undefined ? { timeZone } : {}),
        ...(morningBriefingHourUtc !== undefined ? { morningBriefingHourUtc } : {}),
        ...(quietStartHour !== undefined ? { quietStartHour } : {}),
        ...(quietEndHour !== undefined ? { quietEndHour } : {}),
      }),
    });
    return save.ok;
  } catch {
    return false;
  }
}
