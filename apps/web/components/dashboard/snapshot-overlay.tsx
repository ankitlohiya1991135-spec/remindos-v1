"use client";

/**
 * SnapshotOverlay ("Workspace" side-panel)
 *
 * A right-edge slide-in panel showing:
 *   - Reminder stats (Missed / Today / Tomorrow / Later) — each tappable to filter
 *   - Quick action buttons (Next 2 Hrs, New Reminder, All Reminders, Create Task, All Tasks, Run Briefing)
 *   - Import / Export / Batch utilities
 *   - Quick settings (suggested questions, push notifications, morning briefing, sound)
 *   - Full notification prefs (collapsed by default)
 *   - Clear chat / Account / Sign out
 *
 * Extracted from dashboard-workspace.tsx. All state lives in the parent;
 * this component is purely presentational.
 */

import type { DueNotificationPrefs } from "../../lib/reminder-notification-prefs";
import { NotificationPrefsPanel } from "../notifications/notification-prefs-panel";
import type { ReminderListTab } from "./dashboard-workspace";

const SHOW_SUGGESTED_QUESTIONS_KEY = "remindos:showSuggestedQuestions";

export interface SnapshotOverlayProps {
  /** Reminder counts */
  snapshot: { missed: number; today: number; tomorrow: number; pending: number };
  /** Count of reminders that are beyond tomorrow */
  laterCount: number;

  /** Close the overlay */
  onClose: () => void;
  /** Open reminder list pre-filtered to a specific tab (and close overlay) */
  onOpenReminderTab: (tab: ReminderListTab) => void;

  /** Quick action handlers */
  onNextTwoHours: () => void;
  onCreateReminder: () => void;
  onAllReminders: () => void;
  onCreateTask: () => void;
  onAllTasks: () => void;
  onRunBriefing: () => void;

  /** Utility handlers */
  onImport: () => void;
  onExport: () => void;
  onBatch: () => void;
  isExportDisabled: boolean;
  isBatchDisabled: boolean;

  /** Suggested questions toggle */
  showSuggestedQuestions: boolean;
  onToggleSuggestedQuestions: (enabled: boolean) => void;

  /** Notification prefs */
  dueNotifPrefs: DueNotificationPrefs;
  onChangeDueNotifPrefs: (next: DueNotificationPrefs) => void;
  onRequestNotifPermission: () => void;

  /** Danger zone */
  onClearChat: () => void;
  isClearingChat: boolean;
  isClearingChatDisabled: boolean;

  /** Account */
  user: {
    firstName?: string | null;
    lastName?: string | null;
    emailAddresses: { emailAddress?: string }[];
  } | null | undefined;
  onSignOut: () => void;
}

export function SnapshotOverlay({
  snapshot,
  laterCount,
  onClose,
  onOpenReminderTab,
  onNextTwoHours,
  onCreateReminder,
  onAllReminders,
  onCreateTask,
  onAllTasks,
  onRunBriefing,
  onImport,
  onExport,
  onBatch,
  isExportDisabled,
  isBatchDisabled,
  showSuggestedQuestions,
  onToggleSuggestedQuestions,
  dueNotifPrefs,
  onChangeDueNotifPrefs,
  onRequestNotifPermission,
  onClearChat,
  isClearingChat,
  isClearingChatDisabled,
  user,
  onSignOut,
}: SnapshotOverlayProps) {
  const pushGranted =
    typeof Notification !== "undefined" &&
    Notification.permission === "granted";
  const pushDenied =
    typeof Notification !== "undefined" &&
    Notification.permission === "denied";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50"
      onClick={onClose}
    >
      <aside
        className="absolute right-0 top-0 flex h-full w-[min(22rem,92vw)] flex-col overflow-hidden border-l border-slate-100 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))] dark:border-slate-800">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-violet-600 dark:text-violet-400">
            Workspace
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">

          {/* Stats row — each tile opens the matching reminder tab */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onOpenReminderTab("missed")}
              className="flex flex-col items-center justify-center rounded-xl border border-rose-100 bg-rose-50 px-1 py-3 text-center transition hover:bg-rose-100 active:scale-95 dark:border-rose-900/40 dark:bg-rose-950/30 dark:hover:bg-rose-950/50"
            >
              <span className="text-2xl font-extrabold tabular-nums leading-none text-rose-600 dark:text-rose-400">
                {snapshot.missed}
              </span>
              <span className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-rose-500/80 dark:text-rose-400/70">
                Missed
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenReminderTab("today")}
              className="flex flex-col items-center justify-center rounded-xl border border-amber-100 bg-amber-50 px-1 py-3 text-center transition hover:bg-amber-100 active:scale-95 dark:border-amber-900/40 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
            >
              <span className="text-2xl font-extrabold tabular-nums leading-none text-amber-600 dark:text-amber-400">
                {snapshot.today}
              </span>
              <span className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-500/80 dark:text-amber-400/70">
                Today
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenReminderTab("tomorrow")}
              className="flex flex-col items-center justify-center rounded-xl border border-sky-100 bg-sky-50 px-1 py-3 text-center transition hover:bg-sky-100 active:scale-95 dark:border-sky-900/40 dark:bg-sky-950/30 dark:hover:bg-sky-950/50"
            >
              <span className="text-2xl font-extrabold tabular-nums leading-none text-sky-600 dark:text-sky-400">
                {snapshot.tomorrow}
              </span>
              <span className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-sky-500/80 dark:text-sky-400/70">
                Tomorrow
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenReminderTab("upcoming")}
              className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-1 py-3 text-center transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              <span className="text-2xl font-extrabold tabular-nums leading-none text-slate-700 dark:text-slate-300">
                {laterCount}
              </span>
              <span className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-400">
                Later
              </span>
            </button>
          </div>

          {/* Quick actions grid */}
          <p className="mb-2.5 mt-5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Quick Actions
          </p>
          <div className="grid grid-cols-2 gap-2">
            {([
              {
                icon: "⏱",
                label: "Next 2 Hours",
                onClick: onNextTwoHours,
                color: "from-amber-500 to-orange-600 ring-1 ring-amber-400/25",
              },
              {
                icon: "+",
                label: "New Reminder",
                onClick: onCreateReminder,
                color: "from-violet-500 to-violet-700 ring-1 ring-violet-400/25",
              },
              {
                icon: "☰",
                label: "All Reminders",
                onClick: onAllReminders,
                color: "from-violet-500 to-violet-700 ring-1 ring-violet-400/25",
              },
              {
                icon: "✓",
                label: "Create Task",
                onClick: onCreateTask,
                color: "from-violet-500 to-violet-700 ring-1 ring-violet-400/25",
              },
              {
                icon: "≣",
                label: "All Tasks",
                onClick: onAllTasks,
                color: "from-teal-500 to-teal-700 ring-1 ring-teal-400/25",
              },
              {
                icon: "✦",
                label: "Run Briefing",
                onClick: onRunBriefing,
                color: "from-cyan-500 to-cyan-700 ring-1 ring-cyan-400/25",
              },
            ] as { icon: string; label: string; onClick: () => void; color: string }[]).map(
              (action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className={`flex min-h-[3rem] flex-col items-center justify-center gap-0.5 rounded-xl bg-gradient-to-b px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] ${action.color}`}
                >
                  <span className="text-sm leading-none opacity-90">{action.icon}</span>
                  <span className="mt-0.5 leading-tight">{action.label}</span>
                </button>
              )
            )}
          </div>

          {/* Import / Export / Batch */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={onImport}
              className="flex min-h-[2.25rem] items-center justify-center rounded-xl border border-slate-200 bg-slate-50/90 text-xs font-semibold text-slate-700 transition hover:bg-white hover:shadow-sm active:scale-[0.97] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Import
            </button>
            <button
              type="button"
              onClick={onExport}
              disabled={isExportDisabled}
              className="flex min-h-[2.25rem] items-center justify-center rounded-xl border border-slate-200 bg-slate-50/90 text-xs font-semibold text-slate-700 transition hover:bg-white hover:shadow-sm active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Export
            </button>
            <button
              type="button"
              onClick={onBatch}
              disabled={isBatchDisabled}
              className="flex min-h-[2.25rem] items-center justify-center rounded-xl border border-slate-200 bg-slate-50/90 text-xs font-semibold text-slate-700 transition hover:bg-white hover:shadow-sm active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Batch
            </button>
          </div>

          {/* Quick settings */}
          <p className="mb-1 mt-5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Quick Settings
          </p>
          <div className="overflow-hidden rounded-2xl border border-slate-100 dark:border-slate-800">
            {/* Suggested questions toggle */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Suggested questions
              </span>
              <div className="relative shrink-0">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={showSuggestedQuestions}
                  onChange={(e) => {
                    const on = e.target.checked;
                    onToggleSuggestedQuestions(on);
                    try {
                      localStorage.setItem(SHOW_SUGGESTED_QUESTIONS_KEY, on ? "1" : "0");
                    } catch {
                      /* ignore */
                    }
                  }}
                />
                <div
                  className={`h-6 w-11 rounded-full transition-colors ${
                    showSuggestedQuestions ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"
                  }`}
                />
                <div
                  className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    showSuggestedQuestions ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </div>
            </label>
            {/* Push notifications toggle */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Push notifications
              </span>
              <div className="relative shrink-0">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={dueNotifPrefs.enabled && pushGranted}
                  onChange={(e) => {
                    if (e.target.checked) onRequestNotifPermission();
                    else onChangeDueNotifPrefs({ ...dueNotifPrefs, enabled: false });
                  }}
                  disabled={pushDenied}
                />
                <div
                  className={`h-6 w-11 rounded-full transition-colors ${
                    dueNotifPrefs.enabled && pushGranted
                      ? "bg-violet-600"
                      : "bg-slate-200 dark:bg-slate-700"
                  }`}
                />
                <div
                  className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    dueNotifPrefs.enabled && pushGranted ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </div>
            </label>
            {/* Morning briefing toggle */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Morning briefing
              </span>
              <div className="relative shrink-0">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={dueNotifPrefs.morningBriefingEnabled}
                  onChange={(e) =>
                    onChangeDueNotifPrefs({ ...dueNotifPrefs, morningBriefingEnabled: e.target.checked })
                  }
                />
                <div
                  className={`h-6 w-11 rounded-full transition-colors ${
                    dueNotifPrefs.morningBriefingEnabled ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"
                  }`}
                />
                <div
                  className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    dueNotifPrefs.morningBriefingEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </div>
            </label>
            {/* Sound alerts toggle */}
            <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Sound alerts
              </span>
              <div className="relative shrink-0">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={dueNotifPrefs.soundEnabled}
                  onChange={(e) =>
                    onChangeDueNotifPrefs({ ...dueNotifPrefs, soundEnabled: e.target.checked })
                  }
                />
                <div
                  className={`h-6 w-11 rounded-full transition-colors ${
                    dueNotifPrefs.soundEnabled ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"
                  }`}
                />
                <div
                  className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    dueNotifPrefs.soundEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </div>
            </label>
          </div>

          {/* Full prefs panel (collapsed by default) */}
          <details className="mt-2">
            <summary className="cursor-pointer rounded-xl border border-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-900">
              More notification options…
            </summary>
            <div className="mt-2">
              <NotificationPrefsPanel
                prefs={dueNotifPrefs}
                onChange={onChangeDueNotifPrefs}
                onRequestPermission={onRequestNotifPermission}
              />
            </div>
          </details>

          {/* Divider */}
          <div className="my-4 h-px bg-slate-100 dark:bg-slate-800" />

          {/* Clear chat */}
          <button
            type="button"
            onClick={onClearChat}
            disabled={isClearingChatDisabled}
            className="w-full rounded-xl border border-rose-200 bg-rose-50/80 py-2.5 text-center text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-400 dark:hover:bg-rose-950/60"
          >
            {isClearingChat ? "Clearing…" : "Clear Chat History"}
          </button>

          {/* Account */}
          <div className="mt-3 overflow-hidden rounded-2xl border border-slate-100 dark:border-slate-800">
            {user && (
              <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#7c3aed_0%,#5b7bff_100%)] text-sm font-bold text-white">
                  {(
                    user.firstName?.[0] ??
                    user.emailAddresses[0]?.emailAddress?.[0] ??
                    "U"
                  ).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {user.firstName
                      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ""}`
                      : (user.emailAddresses[0]?.emailAddress ?? "Account")}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    {user.emailAddresses[0]?.emailAddress ?? ""}
                  </p>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={onSignOut}
              className="flex w-full items-center gap-2 px-4 py-3 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 shrink-0"
                aria-hidden
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
