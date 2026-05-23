"use client";

import {
  type DueNotificationPrefs,
  saveDueNotificationPrefs,
} from "../../lib/reminder-notification-prefs";
import { playDueChime } from "../../lib/notification-sounds";
import { syncReminderPushSubscription } from "../../lib/push-subscription-client";

interface NotificationPrefsPanelProps {
  prefs: DueNotificationPrefs;
  onChange: (next: DueNotificationPrefs) => void;
  onRequestPermission: () => void;
}

// ── Toggle row ────────────────────────────────────────────────────────────────

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
          {label}
        </p>
        {description && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      <div className="relative shrink-0">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div
          className={`h-6 w-11 rounded-full transition-colors ${
            checked ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"
          }`}
        />
        <div
          className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </div>
    </label>
  );
}

// ── Sound options ─────────────────────────────────────────────────────────────

const SOUND_OPTIONS = [
  { label: "Chime", value: "chime" },
  { label: "Ping", value: "ping" },
  { label: "Bell", value: "bell" },
  { label: "Silent", value: "silent" },
] as const;

// ── Pre-due timing options ────────────────────────────────────────────────────

const PRE_DUE_OPTIONS = [
  { label: "5 min", value: 5 },
  { label: "10 min", value: 10 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
];

// ── Morning briefing time options (shown in IST, stored as UTC hour) ──────────
// IST = UTC + 5:30h. We snap to whole UTC hours for simplicity.
// UTC 0 ≈ 5:30 AM IST, UTC 1 ≈ 6:30 AM IST, UTC 2 ≈ 7:30 AM IST, etc.
const BRIEFING_HOUR_OPTIONS = [
  { label: "5:30 AM IST", utcHour: 0 },
  { label: "6:30 AM IST", utcHour: 1 },
  { label: "7:30 AM IST", utcHour: 2 },   // default
  { label: "8:30 AM IST", utcHour: 3 },
  { label: "9:30 AM IST", utcHour: 4 },
  { label: "10:30 AM IST", utcHour: 5 },
];

// ── Quiet hours options ───────────────────────────────────────────────────────
const QUIET_START_OPTIONS = [
  { label: "8 PM", value: 20 },
  { label: "9 PM", value: 21 },
  { label: "10 PM", value: 22 },   // default
  { label: "11 PM", value: 23 },
];
const QUIET_END_OPTIONS = [
  { label: "6 AM", value: 6 },
  { label: "7 AM", value: 7 },
  { label: "8 AM", value: 8 },    // default
  { label: "9 AM", value: 9 },
  { label: "10 AM", value: 10 },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function NotificationPrefsPanel({
  prefs,
  onChange,
  onRequestPermission,
}: NotificationPrefsPanelProps) {
  const update = (patch: Partial<DueNotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    onChange(next);
    saveDueNotificationPrefs(next);
  };

  const permissionGranted =
    typeof Notification !== "undefined" && Notification.permission === "granted";

  // Derive active sound chip: "chime" if soundEnabled, else "silent"
  const currentSound: string = prefs.soundEnabled ? "chime" : "silent";

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      {/* Push permission card */}
      {!permissionGranted && (
        <div className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/40 dark:bg-amber-900/20">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
            Push notifications not enabled
          </p>
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
            Enable them to receive reminders even when the app is closed.
          </p>
          <button
            onClick={onRequestPermission}
            className="mt-2 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-600"
          >
            Enable Push
          </button>
        </div>
      )}

      {/* Toggle rows */}
      <div className="divide-y divide-slate-100 px-4 dark:divide-slate-800">
        <Toggle
          label="Due-time alerts"
          description="Alert in-app when a reminder fires"
          checked={prefs.enabled}
          onChange={(v) => update({ enabled: v })}
        />
        <Toggle
          label="Push notifications"
          description="Push when app is in background"
          checked={prefs.desktopEnabled}
          onChange={(v) => update({ desktopEnabled: v })}
        />
        <Toggle
          label="Pre-due alert"
          description="Alert before reminder is due (set timing below)"
          checked={prefs.preDueMinutes > 0}
          onChange={(v) => {
            const minutes = v ? 15 : 0;
            update({ preDueMinutes: minutes });
            void syncReminderPushSubscription(minutes);
          }}
        />
        <Toggle
          label="Morning briefing"
          description="Daily 7:30 am reminder summary"
          checked={prefs.morningBriefingEnabled}
          onChange={(v) => update({ morningBriefingEnabled: v })}
        />
        <Toggle
          label="Overdue nudges"
          description="Hourly alert for past-due reminders"
          checked={prefs.overdueNudgeEnabled}
          onChange={(v) => update({ overdueNudgeEnabled: v })}
        />
        <Toggle
          label="Smart nudges ✨"
          description="Witty reminders when you haven't opened the app in a day"
          checked={prefs.smartNudgeEnabled}
          onChange={(v) => {
            update({ smartNudgeEnabled: v });
            void syncReminderPushSubscription(prefs.preDueMinutes, v);
          }}
        />
      </div>

      {/* Notification sound */}
      <div className="border-t border-slate-100 px-4 pb-4 pt-3 dark:border-slate-800">
        <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
          Notification Sound
        </p>
        <div className="flex flex-wrap gap-2">
          {SOUND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                const enabled = opt.value !== "silent";
                update({ soundEnabled: enabled });
                if (enabled) playDueChime();
              }}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                currentSound === opt.value
                  ? "border-violet-500 bg-violet-600 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pre-due timing */}
      <div className="border-t border-slate-100 px-4 pb-4 pt-3 dark:border-slate-800">
        <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
          Pre-due Alert Timing
        </p>
        <div className="flex flex-wrap gap-2">
          {PRE_DUE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                update({ preDueMinutes: opt.value });
                void syncReminderPushSubscription(opt.value);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                prefs.preDueMinutes === opt.value
                  ? "border-violet-500 bg-violet-600 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Push notification sent this long before each reminder
        </p>
      </div>

      {/* Morning briefing time */}
      {prefs.morningBriefingEnabled && (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3 dark:border-slate-800">
          <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Morning Briefing Time
          </p>
          <div className="flex flex-wrap gap-2">
            {BRIEFING_HOUR_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  update({ morningBriefingHourUtc: opt.utcHour });
                  void syncReminderPushSubscription(
                    prefs.preDueMinutes,
                    prefs.smartNudgeEnabled,
                    opt.utcHour,
                    prefs.quietStartHour,
                    prefs.quietEndHour,
                  );
                }}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  prefs.morningBriefingHourUtc === opt.utcHour
                    ? "border-violet-500 bg-violet-600 text-white"
                    : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Daily summary notification at this time
          </p>
        </div>
      )}

      {/* Smart nudge quiet hours */}
      {prefs.smartNudgeEnabled && (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3 dark:border-slate-800">
          <p className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Smart Nudge Quiet Hours
          </p>
          <p className="mb-2.5 text-[11px] text-slate-400">No notifications between these hours</p>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">From</p>
              <div className="flex flex-wrap gap-1.5">
                {QUIET_START_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      update({ quietStartHour: opt.value });
                      void syncReminderPushSubscription(
                        prefs.preDueMinutes,
                        prefs.smartNudgeEnabled,
                        prefs.morningBriefingHourUtc,
                        opt.value,
                        prefs.quietEndHour,
                      );
                    }}
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                      prefs.quietStartHour === opt.value
                        ? "border-violet-500 bg-violet-600 text-white"
                        : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">Until</p>
              <div className="flex flex-wrap gap-1.5">
                {QUIET_END_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      update({ quietEndHour: opt.value });
                      void syncReminderPushSubscription(
                        prefs.preDueMinutes,
                        prefs.smartNudgeEnabled,
                        prefs.morningBriefingHourUtc,
                        prefs.quietStartHour,
                        opt.value,
                      );
                    }}
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                      prefs.quietEndHour === opt.value
                        ? "border-violet-500 bg-violet-600 text-white"
                        : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
