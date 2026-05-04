"use client";

import {
  type DueNotificationPrefs,
  saveDueNotificationPrefs,
} from "../../lib/reminder-notification-prefs";
import { playDueChime } from "../../lib/notification-sounds";

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
          label="Pre-due 15 min"
          description="Alert 15 min before reminder is due"
          checked={prefs.preDueMinutes > 0}
          onChange={(v) => update({ preDueMinutes: v ? 15 : 0 })}
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
              onClick={() => update({ preDueMinutes: opt.value })}
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
    </div>
  );
}
