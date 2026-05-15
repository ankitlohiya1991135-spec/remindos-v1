"use client";

/**
 * ChatPanelHeader
 *
 * The header region at the top of the dark chat column. Three zones:
 *
 *  1. Mobile top bar (lg:hidden) — greeting + non-zero reminder count pills
 *  2. Tablet toolbar (hidden sm:flex lg:hidden) — shortcut buttons + notification bell + briefing
 *  3. Desktop urgency strip (hidden lg:flex) — overdue / today / tomorrow reminder pills
 *
 * Extracted from dashboard-workspace.tsx.
 */

import { NotificationBell } from "../notifications/notification-bell";
import type { ReminderListTab } from "./dashboard-workspace";

export interface ChatPanelHeaderProps {
  /** User's first name for the greeting (null/undefined = show generic greeting) */
  firstName?: string | null;

  /** Reminder snapshot counts */
  snapshot: { missed: number; today: number; tomorrow: number };
  /** Count of upcoming (later) reminders */
  laterCount: number;

  /** Open reminder list pre-filtered to a tab */
  onOpenReminderTab: (tab: ReminderListTab) => void;
  /** Shortcut action handlers */
  onNextTwoHours: () => void;
  onAllReminders: () => void;
  onAllTasks: () => void;
  onOpenMore: () => void;
  onRunBriefing: () => void;
  isBriefingDisabled: boolean;
}

export function ChatPanelHeader({
  firstName,
  snapshot,
  laterCount,
  onOpenReminderTab,
  onNextTwoHours,
  onAllReminders,
  onAllTasks,
  onOpenMore,
  onRunBriefing,
  isBriefingDisabled,
}: ChatPanelHeaderProps) {
  return (
    <>
      {/* ── Mobile top bar: greeting + compact stat pills ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(255,255,255,0.07)] px-4 py-2 lg:hidden">
        {/* Greeting — small and unobtrusive */}
        <p className="flex-1 truncate text-xs font-medium text-[rgba(255,255,255,0.45)]">
          {(() => {
            const h = new Date().getHours();
            const g = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
            const name = firstName?.trim();
            return name
              ? `Good ${g}, ${name} ${h < 18 ? "☀️" : "🌙"}`
              : `Good ${g}`;
          })()}
        </p>
        {/* Compact stat pills — only non-zero counts rendered */}
        <div className="flex items-center gap-1.5">
          {(
            [
              {
                count: snapshot.missed,
                label: "Missed",
                bg: "rgba(244,63,94,0.15)",
                border: "rgba(244,63,94,0.35)",
                text: "#fda4af",
                tab: "missed" as const,
              },
              {
                count: snapshot.today,
                label: "Today",
                bg: "rgba(245,158,11,0.15)",
                border: "rgba(245,158,11,0.35)",
                text: "#fcd34d",
                tab: "today" as const,
              },
              {
                count: snapshot.tomorrow,
                label: "Tmr",
                bg: "rgba(124,58,237,0.15)",
                border: "rgba(124,58,237,0.35)",
                text: "#c4b5fd",
                tab: "tomorrow" as const,
              },
              {
                count: laterCount,
                label: "Later",
                bg: "rgba(6,182,212,0.15)",
                border: "rgba(6,182,212,0.35)",
                text: "#67e8f9",
                tab: "upcoming" as const,
              },
            ] as const
          )
            .filter((item) => item.count > 0)
            .map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => onOpenReminderTab(item.tab)}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition active:scale-95"
                style={{
                  background: item.bg,
                  border: `1px solid ${item.border}`,
                  color: item.text,
                }}
              >
                <span className="font-bold">{item.count}</span>
                <span className="opacity-80">{item.label}</span>
              </button>
            ))}
        </div>
      </div>

      {/* ── Tablet toolbar (sm+, hidden on desktop) ── */}
      <div className="hidden shrink-0 items-center justify-end gap-2 border-b border-[rgba(255,255,255,0.08)] px-4 py-3 sm:flex sm:px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onNextTwoHours}
            className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-amber-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
          >
            <span aria-hidden className="text-base">⏱</span>
            Next 2 hrs
          </button>
          <button
            type="button"
            onClick={onAllReminders}
            className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-slate-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
          >
            <span aria-hidden>☰</span>
            Reminders
          </button>
          <button
            type="button"
            onClick={onAllTasks}
            data-walkthrough="all-tasks-trigger"
            className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-teal-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
          >
            <span aria-hidden>≣</span>
            Tasks
          </button>
          <button
            type="button"
            onClick={onOpenMore}
            className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-slate-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
          >
            Menu
          </button>
        </div>
        {/* Notification bell — tablet view (header bell is hidden at sm+) */}
        <NotificationBell pollIntervalMs={30_000} />

        <button
          type="button"
          onClick={onRunBriefing}
          data-walkthrough="briefing-trigger"
          disabled={isBriefingDisabled}
          className="inline-flex h-9 items-center justify-center rounded-full border border-violet-500/40 bg-violet-600/20 px-3 text-[11px] font-semibold text-violet-300 shadow-sm transition hover:bg-violet-600/30 disabled:cursor-not-allowed disabled:opacity-40 sm:h-10 sm:px-4 sm:text-xs"
        >
          Briefing
        </button>
      </div>

      {/* ── Desktop urgency strip (lg+) ── */}
      {(snapshot.missed > 0 || snapshot.today > 0 || snapshot.tomorrow > 0) && (
        <div className="hidden shrink-0 items-center gap-2 overflow-x-auto border-b border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.04)] px-4 py-2 scrollbar-none lg:flex">
          {snapshot.missed > 0 && (
            <button
              type="button"
              onClick={() => onOpenReminderTab("missed")}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
              Overdue
              <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                {snapshot.missed}
              </span>
            </button>
          )}
          {snapshot.today > 0 && (
            <button
              type="button"
              onClick={() => onOpenReminderTab("today")}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/20"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Today
              <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                {snapshot.today}
              </span>
            </button>
          )}
          {snapshot.tomorrow > 0 && (
            <button
              type="button"
              onClick={() => onOpenReminderTab("tomorrow")}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-300 transition hover:bg-violet-500/20"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
              Tomorrow
              <span className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                {snapshot.tomorrow}
              </span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
