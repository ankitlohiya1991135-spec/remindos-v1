"use client";

/**
 * use-due-notifications.ts
 *
 * Manages due notification preferences, the minute-tick effect that fires
 * chat bubbles + system notifications, and the associated UI callbacks.
 * Extracted from dashboard-workspace.tsx to reduce line count.
 */

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ReminderItem } from "@repo/reminder";
import {
  loadDueNotificationPrefs,
  saveDueNotificationPrefs,
  shouldShowSystemDueNotification,
  markNotifDueSent,
  readNotifDueSent,
  isCompactViewport,
  type DueNotificationPrefs,
} from "../../lib/reminder-notification-prefs";
import { showDueReminderSystemNotification } from "../../lib/due-notifications-client";
import { syncReminderPushSubscription } from "../../lib/push-subscription-client";
import { playDueChime } from "../../lib/notification-sounds";
import {
  readDueShown,
  markDueShown,
  dueMinuteKey,
  isDueThisMinute,
  PRE_DUE_SHOWN_KEY,
  readPreDueShown,
  markPreDueShown,
  preDueMinuteKey,
  isDueInMinutes,
} from "./dashboard-utils";
import type { ChatMessage } from "./dashboard-types";

export interface UseDueNotificationsParams {
  isHistoryLoaded: boolean;
  reminders: ReminderItem[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

export function useDueNotifications({
  isHistoryLoaded,
  reminders,
  setMessages,
}: UseDueNotificationsParams) {
  const [dueNotifPrefs, setDueNotifPrefs] = useState<DueNotificationPrefs>(() =>
    loadDueNotificationPrefs(),
  );
  const [notifUiTick, setNotifUiTick] = useState(0);
  const [dueNotifBannerDismissed, setDueNotifBannerDismissed] = useState(false);

  // Restore banner-dismissed flag from sessionStorage
  useEffect(() => {
    try {
      if (
        typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem("remindos:dueNotifBannerDismissed") === "1"
      ) {
        setDueNotifBannerDismissed(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Re-tick on visibility change so notifications fire promptly after tab focus
  useEffect(() => {
    const onVis = () => setNotifUiTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Sync push subscription once history is loaded (and whenever preDueMinutes changes).
  useEffect(() => {
    if (!isHistoryLoaded) return;
    void syncReminderPushSubscription(dueNotifPrefs.preDueMinutes);
  }, [isHistoryLoaded, dueNotifPrefs.preDueMinutes]);

  // Main due-reminder tick: fire chat bubbles + system notifications
  useEffect(() => {
    if (!isHistoryLoaded) return;
    const tick = () => {
      const now = new Date();
      for (const r of reminders) {
        if (r.status !== "pending") continue;
        if (!isDueThisMinute(r.dueAt, now)) continue;
        const key = dueMinuteKey(r);

        if (!readDueShown().has(key)) {
          markDueShown(key);
          const msg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Reminder due: ${r.title}`,
            createdAt: new Date().toISOString(),
            meta: {
              kind: "due_reminder",
              reminderId: r.id,
              dueAt: new Date(r.dueAt).getTime(),
              title: r.title,
              notes: r.notes,
            },
          };
          setMessages((prev) => [...prev, msg]);
          if (dueNotifPrefs.soundEnabled !== false) {
            playDueChime();
          }
          if (typeof navigator !== "undefined" && navigator.vibrate && isCompactViewport()) {
            navigator.vibrate(80);
          }
        }

        if (shouldShowSystemDueNotification(dueNotifPrefs) && !readNotifDueSent(key)) {
          markNotifDueSent(key);
          void (async () => {
            try {
              await showDueReminderSystemNotification(r, key);
            } catch {
              /* iOS / unsupported */
            }
          })();
        }
      }

      // ── Pre-due in-app alert ──────────────────────────────────────────────
      if (dueNotifPrefs.preDueMinutes > 0) {
        for (const r of reminders) {
          if (r.status !== "pending") continue;
          if (!isDueInMinutes(r.dueAt, dueNotifPrefs.preDueMinutes, now)) continue;
          const preKey = preDueMinuteKey(r.id, now);
          if (!readPreDueShown().has(preKey)) {
            markPreDueShown(preKey);
            const msg: ChatMessage = {
              id: crypto.randomUUID(),
              role: "assistant",
              content: `Reminder in ${dueNotifPrefs.preDueMinutes} min: ${r.title}`,
              createdAt: new Date().toISOString(),
              meta: {
                kind: "due_reminder",
                reminderId: r.id,
                dueAt: new Date(r.dueAt).getTime(),
                title: r.title,
                notes: r.notes,
              },
            };
            setMessages((prev) => [...prev, msg]);
            if (dueNotifPrefs.soundEnabled !== false) {
              playDueChime();
            }
            if (typeof navigator !== "undefined" && navigator.vibrate && isCompactViewport()) {
              navigator.vibrate(60);
            }
          }
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 12000);
    return () => window.clearInterval(id);
  }, [reminders, isHistoryLoaded, dueNotifPrefs, notifUiTick, setMessages]);

  const persistDueNotifPrefs = useCallback(
    (patch: Partial<DueNotificationPrefs>) => {
      setDueNotifPrefs((prev) => {
        const next = { ...prev, ...patch };
        saveDueNotificationPrefs(next);
        return next;
      });
    },
    [],
  );

  const requestDueNotificationPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    setNotifUiTick((t) => t + 1);
    if (p === "granted") {
      persistDueNotifPrefs({ enabled: true });
    }
  }, [persistDueNotifPrefs]);

  const dismissDueNotifBanner = useCallback(() => {
    try {
      sessionStorage.setItem("remindos:dueNotifBannerDismissed", "1");
    } catch {
      /* ignore */
    }
    setDueNotifBannerDismissed(true);
  }, []);

  return {
    dueNotifPrefs,
    setDueNotifPrefs,
    dueNotifBannerDismissed,
    persistDueNotifPrefs,
    requestDueNotificationPermission,
    dismissDueNotifBanner,
  } as const;
}
