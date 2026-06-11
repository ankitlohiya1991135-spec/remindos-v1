self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Runtime caching can be added in future versions.
});

// ── helpers ────────────────────────────────────────────────────────────────────

function showNotif(event, title, body, tag, data, actions, extraOpts) {
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/logo-remindos.svg",
      badge: "/logo-remindos.svg",
      tag,
      data,
      actions: actions || [],
      requireInteraction: false,
      vibrate: [200, 100, 200],
      ...(extraOpts || {}),
    })
  );
}

function postToClients(event, msg, fallbackUrl) {
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && client.url.includes(self.location.origin)) {
          client.postMessage(msg);
          if ("focus" in client) return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(fallbackUrl);
    })
  );
}

// ── push handler ───────────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const type = payload.type;

  // ── Share invite ────────────────────────────────────────────────────────────
  if (type === "share_invite") {
    const title = payload.title || "Shared reminders";
    const body = payload.body || "Open to review";
    const batchKey = payload.batchKey || "";
    showNotif(event, title, body, payload.tag || `share-in-${batchKey}`, {
      type: "share_invite", batchKey, fromUserId: payload.fromUserId,
    }, [
      { action: "accept", title: "✅ Accept" },
      { action: "deny",   title: "❌ Deny" },
    ]);
    return;
  }

  // ── Share accepted ──────────────────────────────────────────────────────────
  if (type === "share_accepted") {
    showNotif(event, payload.title || "Reminder share",
      payload.body || "Someone accepted your invites.",
      payload.tag || "share-accepted",
      { type: "share_accepted", batchKey: payload.batchKey }, []);
    return;
  }

  // ── Due reminder ────────────────────────────────────────────────────────────
  if (type === "due_reminder") {
    const title = payload.title || "Reminder due";
    const body = payload.body || "A reminder is due now.";
    showNotif(event, "⏰ " + title, body,
      "due-" + (payload.reminderId || ""),
      { type: "due_reminder", reminderId: payload.reminderId, title: payload.title, dueAt: payload.dueAt },
      [
        { action: "done",   title: "✅ Mark done" },
        { action: "snooze", title: "⏱ Snooze 15 min" },
      ],
      // Keep due-time notifications visible until the user explicitly dismisses them.
      // More insistent vibration pattern differentiates it from the pre-due warning.
      { requireInteraction: true, vibrate: [300, 100, 300, 100, 300] }
    );
    return;
  }

  // ── Pre-due reminder (15 min warning) ───────────────────────────────────────
  if (type === "pre_due_reminder") {
    const title = payload.title || "Upcoming reminder";
    const body = payload.body || "Due soon";
    showNotif(event, "🔔 " + title, body,
      "predue-" + (payload.reminderId || ""),
      { type: "pre_due_reminder", reminderId: payload.reminderId, title: payload.title, dueAt: payload.dueAt },
      [
        { action: "open",   title: "Open" },
        { action: "snooze", title: "⏱ Snooze" },
      ]
    );
    return;
  }

  // ── Overdue nudge ───────────────────────────────────────────────────────────
  if (type === "overdue_nudge") {
    const count = payload.count || 1;
    const title = count === 1 ? "Overdue reminder" : `${count} overdue reminders`;
    const body = payload.body || "You have overdue reminders.";
    showNotif(event, "⚠️ " + title, body,
      "overdue-nudge",
      { type: "overdue_nudge" },
      [{ action: "open", title: "View all" }]
    );
    return;
  }

  // ── Morning briefing ────────────────────────────────────────────────────────
  if (type === "morning_briefing") {
    const count = payload.count || 0;
    const title = `Good morning! ${count} reminder${count !== 1 ? "s" : ""} today`;
    const body = payload.body || "Tap to see your day.";
    showNotif(event, "☀️ " + title, body,
      "morning-briefing",
      { type: "morning_briefing" },
      [{ action: "open", title: "See today" }]
    );
    return;
  }

  // ── Evening wind-down digest ─────────────────────────────────────────────────
  if (type === "evening_briefing") {
    const title = "you did enough today";
    const body = payload.body || "whatever didn't happen will keep. rest easy tonight.";
    showNotif(event, "🌙 " + title, body,
      "evening-briefing",
      { type: "evening_briefing" },
      [{ action: "open", title: "Review" }]
    );
    return;
  }

  // ── Smart engagement nudge (Zomato-style) ────────────────────────────────────
  if (type === "smart_nudge") {
    const title = payload.title || "Hey, you there? 👋";
    const body  = payload.body  || "You have pending tasks waiting for you!";
    showNotif(event, title, body,
      "smart-nudge",   // single tag per user — newer nudge replaces the old one
      { type: "smart_nudge" },
      [
        { action: "open",  title: "Let's go! 🚀" },
        { action: "snooze", title: "Remind me later" },
      ]
    );
    return;
  }
});

// ── notification click handler ─────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  const action = event.action || "open";
  notification.close();

  // Share invite actions
  if (data.type === "share_invite") {
    const batchKey = data.batchKey || "";
    postToClients(event,
      { type: "SHARE_INVITE_NOTIF", action, batchKey },
      (() => {
        const url = new URL("/dashboard", self.location.origin);
        if (action === "accept") { url.searchParams.set("shareBatchAction", "accept"); url.searchParams.set("batchKey", batchKey); }
        else if (action === "deny") { url.searchParams.set("shareBatchAction", "deny"); url.searchParams.set("batchKey", batchKey); }
        return url.href;
      })()
    );
    return;
  }

  // due_reminder / pre_due_reminder action buttons
  if (data.type === "due_reminder" || data.type === "pre_due_reminder") {
    postToClients(event,
      { type: "REMINDER_NOTIF", action, reminderId: data.reminderId, title: data.title, notifType: data.type },
      (() => {
        const url = new URL("/dashboard", self.location.origin);
        url.searchParams.set("notifAction", action);
        if (data.reminderId) url.searchParams.set("reminderId", data.reminderId);
        return url.href;
      })()
    );
    return;
  }

  // overdue_nudge / morning_briefing / share_accepted — just open the app
  const fallbackUrl = new URL("/dashboard", self.location.origin).href;
  postToClients(event,
    { type: "REMINDER_NOTIF", action: "open", notifType: data.type },
    fallbackUrl
  );
});
