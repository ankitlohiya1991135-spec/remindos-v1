const STORAGE_KEY = "remindos:dueNotifPrefs";

export type DueNotificationPrefs = {
  /** User opted in to due-time system notifications (browser permission may still be default/denied). */
  enabled: boolean;
  /** If true, show a notification even when the tab is visible (default false). */
  notifyWhenForeground: boolean;
  /** User explicitly enabled on large screens (desktop/tablet landscape). */
  desktopEnabled: boolean;
  /** Play an in-app chime sound when a reminder fires (default true). */
  soundEnabled: boolean;
  /** Show a pre-due push N minutes before (0 = disabled). */
  preDueMinutes: number;
  /** Send a morning briefing push at the configured UTC hour. */
  morningBriefingEnabled: boolean;
  /** UTC hour for morning briefing (default 2 = 7:30 IST). */
  morningBriefingHourUtc: number;
  /** Hourly nudge push for overdue reminders (default true). */
  overdueNudgeEnabled: boolean;
  /**
   * Smart engagement nudges — Zomato-style witty pushes when the user hasn't
   * opened the app for 24+ hours. Opt-in, default false.
   */
  smartNudgeEnabled: boolean;
  /** Local hour (0-23) to start quiet window — no smart nudges after this hour. Default 22 (10 PM). */
  quietStartHour: number;
  /** Local hour (0-23) to end quiet window — nudges resume from this hour. Default 8 (8 AM). */
  quietEndHour: number;
};

const defaultPrefs: DueNotificationPrefs = {
  enabled: false,
  notifyWhenForeground: false,
  desktopEnabled: false,
  soundEnabled: true,
  preDueMinutes: 15,
  morningBriefingEnabled: true,
  morningBriefingHourUtc: 2,
  overdueNudgeEnabled: true,
  smartNudgeEnabled: false,
  quietStartHour: 22,
  quietEndHour: 8,
};

export function loadDueNotificationPrefs(): DueNotificationPrefs {
  if (typeof window === "undefined") return { ...defaultPrefs };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultPrefs };
    const parsed = JSON.parse(raw) as Partial<DueNotificationPrefs>;
    return {
      ...defaultPrefs,
      ...parsed,
    };
  } catch {
    return { ...defaultPrefs };
  }
}

export function saveDueNotificationPrefs(prefs: DueNotificationPrefs) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

/** Narrow viewports: prefer prompting for alerts (PWA / phone). */
export function isCompactViewport() {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(max-width: 1023px)").matches;
}

export function canUseDueNotifications(prefs: DueNotificationPrefs) {
  if (!prefs.enabled) return false;
  if (typeof window === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  if (isCompactViewport()) return true;
  return prefs.desktopEnabled;
}

/** System notification for this due moment (may still skip if tab visible and user chose quiet foreground). */
export function shouldShowSystemDueNotification(prefs: DueNotificationPrefs) {
  if (!canUseDueNotifications(prefs)) return false;
  if (typeof document === "undefined") return true;
  if (document.visibilityState === "hidden") return true;
  return prefs.notifyWhenForeground;
}

export const NOTIF_DUE_SENT_PREFIX = "remindos:notifDue:";

export function readNotifDueSent(key: string): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(NOTIF_DUE_SENT_PREFIX + key) === "1";
}

export function markNotifDueSent(key: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(NOTIF_DUE_SENT_PREFIX + key, "1");
  } catch {
    /* quota or private mode */
  }
}
