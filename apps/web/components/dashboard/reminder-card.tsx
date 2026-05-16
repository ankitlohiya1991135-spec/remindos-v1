"use client";

/**
 * ReminderCard
 *
 * A single reminder item rendered inside the ReminderList overlay.
 * Handles display of status, tags, actions, and long-press selection.
 *
 * Extracted from dashboard-workspace.tsx.
 */

import { memo } from "react";
import type { ReminderItem } from "@repo/reminder";
import { isAdhocReminder } from "@repo/reminder";
import { reminderStateLabel } from "./dashboard-utils";

export interface ReminderCardProps {
  reminder: ReminderItem;
  tab: string;
  selectionMode: boolean;
  selected: boolean;
  taskTitleById: Record<string, string | undefined>;
  onSelect: (id: string) => void;
  onLongPressStart: (id: string) => void;
  onLongPressEnd: () => void;
  onMarkDone: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onShare: () => void;
  onSnooze: () => void;
}

export const ReminderCard = memo(function ReminderCard({
  reminder,
  tab,
  selectionMode,
  selected,
  taskTitleById,
  onSelect,
  onLongPressStart,
  onLongPressEnd,
  onMarkDone,
  onDelete,
  onEdit,
  onShare,
  onSnooze,
}: ReminderCardProps) {
  const isDone = reminder.status === "done" || reminder.status === "archived";
  const linkedTaskTitle = reminder.linkedTaskId ? taskTitleById[reminder.linkedTaskId] : undefined;
  const isAdhoc = isAdhocReminder(reminder) || !linkedTaskTitle;

  const circleColor =
    tab === "done"      ? "#10b981" :
    tab === "missed"    ? "#f43f5e" :
    tab === "today"     ? "#f59e0b" :
    tab === "tomorrow"  ? "#7c3aed" :
    tab === "shared" || tab === "sent" ? "#06b6d4" :
    "#94a3b8";

  // Compute overdue label for missed tab
  let overdueLabel = "";
  if (tab === "missed") {
    const diffMs = Date.now() - new Date(reminder.dueAt).getTime();
    const diffH = Math.floor(diffMs / (1000 * 60 * 60));
    const diffM = Math.floor(diffMs / (1000 * 60));
    overdueLabel = diffH > 0 ? `${diffH}h overdue` : diffM > 0 ? `${diffM}m overdue` : "Just missed";
  }

  // Friendly time label
  let timeLabel = "";
  try {
    timeLabel = new Date(reminder.dueAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch { /* ignore */ }

  const domainColors: Record<string, string> = {
    health:  "#10b981",
    finance: "#06b6d4",
    career:  "#6366f1",
    hobby:   "#7c3aed",
    fun:     "#f59e0b",
  };
  const domainColor = reminder.domain ? (domainColors[reminder.domain] ?? "#94a3b8") : "#94a3b8";

  return (
    <article
      data-testid="reminder-card"
      data-reminder-id={reminder.id}
      className={`mb-2 flex gap-3 rounded-2xl border bg-white px-3.5 py-3 shadow-sm transition ${
        selected ? "border-violet-400 ring-2 ring-violet-400/25" : "border-slate-100"
      }`}
      onTouchStart={() => onLongPressStart(reminder.id)}
      onTouchEnd={onLongPressEnd}
      onTouchMove={onLongPressEnd}
    >
      {/* Left indicator */}
      <div className="flex shrink-0 flex-col items-center pt-0.5">
        {selectionMode && !isDone && reminder.access !== "shared" ? (
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-400 text-violet-600"
            checked={selected}
            onChange={() => onSelect(reminder.id)}
            aria-label={`Select ${reminder.title}`}
          />
        ) : isDone ? (
          /* Green checkmark circle for done */
          <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: "#10b981" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
              <path d="m5 12 4 4 10-10" />
            </svg>
          </span>
        ) : (
          <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: circleColor }} />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Title row */}
        <div className="flex items-start justify-between gap-1">
          <p className={`text-[14px] font-semibold leading-snug ${isDone ? "text-slate-400 line-through" : "text-slate-900"}`}>
            {reminder.title}
            {(reminder.priority ?? 0) > 0 && (
              <span className="ml-1 text-amber-400">{"★".repeat(reminder.priority ?? 0)}</span>
            )}
          </p>
        </div>

        {/* Time row */}
        <p className={`mt-0.5 text-[11px] font-medium ${
          tab === "missed" ? "text-rose-500" :
          tab === "today"  ? "text-amber-500" :
          isDone           ? "text-emerald-500" :
          "text-slate-400"
        }`}>
          {tab === "missed"
            ? `Due at ${new Date(reminder.dueAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ${overdueLabel}`
            : timeLabel}
        </p>

        {/* Tags row */}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* Status tag */}
          {tab !== "done" && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                tab === "missed" ? "bg-rose-50 text-rose-600" :
                tab === "today"  ? "bg-amber-50 text-amber-600" :
                tab === "tomorrow" ? "bg-violet-50 text-violet-600" :
                "bg-slate-100 text-slate-500"
              }`}
              data-testid="reminder-state-label"
            >
              {reminderStateLabel(
                reminder,
                new Date(),
                typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
              )}
            </span>
          )}
          {/* Shared tag */}
          {reminder.access === "shared" && (
            <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-sky-600">
              Shared
            </span>
          )}
          {/* ADHOC / Task tag */}
          {isAdhoc ? (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500">ADHOC</span>
          ) : (
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold text-indigo-600">
              {linkedTaskTitle}
            </span>
          )}
          {/* Recurrence tag */}
          {(() => {
            const rec = reminder.recurrence;
            if (rec === "daily" || rec === "weekly" || rec === "monthly") {
              const tone =
                rec === "daily" ? "bg-emerald-50 text-emerald-700"
                : rec === "weekly" ? "bg-teal-50 text-teal-700"
                : "bg-cyan-50 text-cyan-700";
              return (
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${tone}`}>
                  ↻ {rec}
                </span>
              );
            }
            return (
              <span className="rounded-full bg-slate-50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500">
                One-time
              </span>
            );
          })()}
          {/* Domain tag */}
          {reminder.domain && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase"
              style={{ background: `${domainColor}18`, color: domainColor }}
            >
              {reminder.domain}
            </span>
          )}
        </div>

        {/* Notes */}
        {reminder.notes && !isDone && (
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{reminder.notes}</p>
        )}

        {/* Action buttons */}
        {!isDone && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={onMarkDone}
              data-testid="reminder-status-button"
              className="flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-[10px] font-bold text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="m5 12 4 4 10-10"/></svg>
              Done
            </button>
            <button
              type="button"
              onClick={onEdit}
              data-testid="reminder-edit-button"
              className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-bold text-slate-600"
            >
              Edit
            </button>
            {reminder.access !== "shared" && (
              <button
                type="button"
                onClick={onShare}
                data-testid="reminder-share-button"
                className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-700"
              >
                Share
              </button>
            )}
            {tab !== "done" && (
              <button
                type="button"
                onClick={onSnooze}
                className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-bold text-slate-500"
              >
                +1h
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              data-testid="reminder-delete-button"
              className="rounded-full border border-rose-100 bg-rose-50 px-2.5 py-1 text-[10px] font-bold text-rose-600"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </article>
  );
});
