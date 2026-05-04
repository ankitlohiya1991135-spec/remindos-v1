"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { LifeDomain, ReminderItem } from "@repo/reminder";

export interface TaskRow {
  id: string;
  title: string;
  notes?: string;
  dueAt?: string;
  status: "pending" | "done";
  priority?: number;
  domain?: LifeDomain;
}

export interface TaskGroups {
  missed: TaskRow[];
  pending: TaskRow[];
  done: TaskRow[];
}

interface TaskListOverlayProps {
  open: boolean;
  taskTab: "missed" | "pending" | "done" | "all";
  setTaskTab: (tab: "missed" | "pending" | "done" | "all") => void;
  taskSearchQuery: string;
  setTaskSearchQuery: (value: string) => void;
  tasksGrouped: TaskGroups;
  reminders: ReminderItem[];
  onClose: () => void;
  onViewReminders: () => void;
  onCreateTask: () => void;
  onEditTask: (task: TaskRow) => void;
  onToggleStatus: (task: TaskRow) => void;
  onDeleteTask: (task: TaskRow) => void;
  onCreateLinkedReminder: (task: TaskRow) => void;
  onReminderMarkDone: (reminder: ReminderItem) => void;
  onReminderEdit: (reminder: ReminderItem) => void;
  onReminderReschedule: (reminder: ReminderItem) => void;
  onReminderDelete: (reminder: ReminderItem) => void;
}

interface TaskFormOverlayProps {
  open: boolean;
  editingTaskId: string | null;
  taskFormTitle: string;
  setTaskFormTitle: (value: string) => void;
  taskFormDue: string;
  setTaskFormDue: (value: string) => void;
  taskFormNotes: string;
  setTaskFormNotes: (value: string) => void;
  taskFormDomain: "" | LifeDomain;
  setTaskFormDomain: (value: "" | LifeDomain) => void;
  taskStars: number;
  setTaskStars: (value: number) => void;
  taskFormError: string | null;
  setTaskFormError: (value: string | null) => void;
  taskDueUserEdited: boolean;
  setTaskDueUserEdited: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancelEdit: () => void;
  onClose: () => void;
  onViewReminders: () => void;
  onCreateLinkedReminder: () => void;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const DOMAIN_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  health:  { bg: "#d1fae5", text: "#065f46", border: "#6ee7b7" },
  finance: { bg: "#cffafe", text: "#155e75", border: "#67e8f9" },
  career:  { bg: "#e0e7ff", text: "#3730a3", border: "#a5b4fc" },
  hobby:   { bg: "#ede9fe", text: "#5b21b6", border: "#c4b5fd" },
  fun:     { bg: "#fef3c7", text: "#78350f", border: "#fcd34d" },
};

function domainStyle(domain?: string) {
  if (!domain) return {};
  const c = DOMAIN_COLORS[domain];
  if (!c) return {};
  return { background: c.bg, color: c.text, border: `1px solid ${c.border}` };
}

function formatShortDate(iso?: string) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatReminderTime(iso: string | number) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ─── TaskListCard ─────────────────────────────────────────────────────────────

function TaskListCard({
  task,
  reminders,
  onEditTask,
  onToggleStatus,
  onDeleteTask,
  onCreateLinkedReminder,
  onReminderMarkDone,
  onReminderEdit,
  onReminderReschedule,
}: {
  task: TaskRow;
  reminders: ReminderItem[];
  onEditTask: (task: TaskRow) => void;
  onToggleStatus: (task: TaskRow) => void;
  onDeleteTask: (task: TaskRow) => void;
  onCreateLinkedReminder: (task: TaskRow) => void;
  onReminderMarkDone: (reminder: ReminderItem) => void;
  onReminderEdit: (reminder: ReminderItem) => void;
  onReminderReschedule: (reminder: ReminderItem) => void;
  onReminderDelete: (reminder: ReminderItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const linkedAll = reminders.filter((r) => r.linkedTaskId === task.id);
  const linkedPending = linkedAll.filter((r) => r.status === "pending");
  const linkedDone = linkedAll.filter(
    (r) => r.status === "done" || r.status === "archived",
  );
  const isDone = task.status === "done";
  const stars = task.priority ?? 0;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm"
      data-testid="task-card"
      data-task-id={task.id}
    >
      {/* ── Main card ── */}
      <div className="px-4 py-3.5">
        {/* Title row */}
        <div className="flex items-start gap-3">
          {/* Checkbox */}
          <div
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition ${
              isDone ? "border-emerald-500 bg-emerald-500" : "border-slate-300"
            }`}
          >
            {isDone && (
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                <path d="m5 12 4 4 10-10" />
              </svg>
            )}
          </div>

          {/* Title + expand button */}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className={`font-bold leading-snug text-slate-900 ${isDone ? "text-slate-400 line-through" : ""}`}>
                {task.title}
              </p>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="shrink-0 text-slate-400 transition"
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>

            {/* Stars + domain + due date */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {stars > 0 && (
                <span className="text-[12px] text-amber-400">{"★".repeat(stars)}{"☆".repeat(5 - stars)}</span>
              )}
              {task.domain && (
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                  style={domainStyle(task.domain)}
                >
                  {task.domain}
                </span>
              )}
              {task.dueAt && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                  Due {formatShortDate(task.dueAt)}
                </span>
              )}
            </div>

            {/* Reminder count badges */}
            {linkedAll.length > 0 && (
              <div className="mt-2 flex gap-2">
                {linkedPending.length > 0 && (
                  <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-[10px] font-semibold text-violet-600">
                    {linkedPending.length} reminder{linkedPending.length > 1 ? "s" : ""}
                  </span>
                )}
                {linkedDone.length > 0 && (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-600">
                    {linkedDone.length} done
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onCreateLinkedReminder(task)}
            data-testid="task-create-linked-reminder-button"
            className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-bold text-violet-700"
          >
            + Reminder
          </button>
          <button
            type="button"
            onClick={() => onEditTask(task)}
            data-testid="task-edit-button"
            className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-bold text-slate-600"
          >
            Edit
          </button>
          {isDone ? (
            <button
              type="button"
              onClick={() => onToggleStatus(task)}
              data-testid="task-status-button"
              className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-bold text-slate-500"
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onToggleStatus(task)}
              data-testid="task-status-button"
              className="flex items-center gap-1 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-bold text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m5 12 4 4 10-10"/></svg>
              Done
            </button>
          )}
          <button
            type="button"
            onClick={() => onDeleteTask(task)}
            data-testid="task-delete-button"
            className="rounded-full border border-rose-100 bg-rose-50 px-3 py-1 text-[11px] font-bold text-rose-600"
          >
            Delete
          </button>
        </div>
      </div>

      {/* ── Expanded detail (Screen 09 style) ── */}
      {expanded && (
        <div className="border-t border-slate-100">
          {/* Notes */}
          {task.notes && (
            <div className="px-4 py-3 text-[13px] leading-relaxed text-slate-500">
              {task.notes}
            </div>
          )}

          {/* Linked reminders — pending */}
          {linkedPending.length > 0 && (
            <div className="border-t border-slate-100 px-4 py-3">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-violet-600">
                  LINKED REMINDERS ({linkedPending.length} PENDING)
                </p>
                <button
                  type="button"
                  onClick={() => onCreateLinkedReminder(task)}
                  className="rounded-full bg-violet-600 px-3 py-1 text-[10px] font-bold text-white"
                >
                  + Add
                </button>
              </div>
              <div className="space-y-2.5">
                {linkedPending.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-white px-3 py-3"
                    data-testid={`task-reminder-row-${r.id}`}
                  >
                    {/* Green checkmark to mark done */}
                    <button
                      type="button"
                      onClick={() => onReminderMarkDone(r)}
                      data-testid={`task-reminder-done-${r.id}`}
                      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                        <path d="m5 12 4 4 10-10" />
                      </svg>
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[13px] font-semibold text-slate-900">{r.title}</p>
                        <span className="shrink-0 text-[11px] text-amber-400">
                          {"★".repeat(r.priority ?? 0)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">{formatReminderTime(r.dueAt)}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => onReminderEdit(r)}
                          data-testid={`task-reminder-edit-${r.id}`}
                          className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-bold text-slate-600"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onReminderReschedule(r)}
                          data-testid={`task-reminder-reschedule-${r.id}`}
                          className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[10px] font-bold text-cyan-700"
                        >
                          Reschedule
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Completed reminders on this task */}
          {linkedDone.length > 0 && (
            <div className="border-t border-slate-100 px-4 py-3">
              <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-widest text-emerald-600">
                COMPLETED ON THIS TASK ({linkedDone.length})
              </p>
              <div className="space-y-1.5">
                {linkedDone.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 border-l-2 border-emerald-200 pl-3">
                    <p className="text-[12px] text-slate-400 line-through">{r.title}</p>
                    <span className="text-[10px] text-slate-300">
                      {formatShortDate(r.dueAt.toString())} · Done
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom actions */}
          <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-3">
            {!isDone && (
              <button
                type="button"
                onClick={() => onToggleStatus(task)}
                data-testid="task-status-button"
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-3 text-[13px] font-bold text-white"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m5 12 4 4 10-10"/></svg>
                Mark Task Done
              </button>
            )}
            <button
              type="button"
              onClick={() => onDeleteTask(task)}
              data-testid="task-delete-button"
              className={`text-[13px] font-bold text-rose-500 ${isDone ? "flex-1 rounded-2xl border border-rose-200 py-3 text-center" : ""}`}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TaskListOverlay ──────────────────────────────────────────────────────────

export function TaskListOverlay({
  open,
  taskTab,
  setTaskTab,
  taskSearchQuery,
  setTaskSearchQuery,
  tasksGrouped,
  reminders,
  onClose,
  onViewReminders,
  onCreateTask,
  onEditTask,
  onToggleStatus,
  onDeleteTask,
  onCreateLinkedReminder,
  onReminderMarkDone,
  onReminderEdit,
  onReminderReschedule,
  onReminderDelete,
}: TaskListOverlayProps) {
  if (!open) return null;

  const baseTasks =
    taskTab === "missed"
      ? tasksGrouped.missed
      : taskTab === "pending"
        ? tasksGrouped.pending
        : taskTab === "done"
          ? tasksGrouped.done
          : [...tasksGrouped.missed, ...tasksGrouped.pending, ...tasksGrouped.done];

  const q = taskSearchQuery.trim().toLowerCase();
  const activeTasks =
    taskTab === "all" && q
      ? baseTasks.filter((task) => {
          const hay = [task.title, task.notes ?? "", task.domain ?? "", task.status]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : baseTasks;

  const tabs: { key: "pending" | "missed" | "done" | "all"; label: string; count: number; dot?: string }[] = [
    { key: "pending", label: "Upcoming", count: tasksGrouped.pending.length },
    { key: "missed",  label: "Missed",   count: tasksGrouped.missed.length,  dot: "#f43f5e" },
    { key: "done",    label: "Done",     count: tasksGrouped.done.length,    dot: "#10b981" },
    {
      key: "all",
      label: "All",
      count: tasksGrouped.missed.length + tasksGrouped.pending.length + tasksGrouped.done.length,
    },
  ];

  return (
    <div
      data-testid="task-list-overlay"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tasks-list-title"
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-[#fafaf9] shadow-2xl sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Handle bar */}
        <div className="flex shrink-0 justify-center pt-2.5 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-slate-200" />
        </div>

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-5 py-3">
          <h2 id="tasks-list-title" className="text-[20px] font-extrabold text-slate-900">Tasks</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCreateTask}
              data-testid="task-create-button"
              className="flex items-center gap-1 rounded-full bg-teal-500 px-4 py-2 text-[13px] font-bold text-white shadow-sm"
            >
              <span className="text-base leading-none">+</span> Task
            </button>
            <button
              type="button"
              onClick={onClose}
              data-testid="task-panel-close"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-400"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-3 scrollbar-none">
          {tabs.map((tab) => {
            const active = taskTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setTaskTab(tab.key)}
                data-testid={`task-tab-${tab.key}`}
                className={`shrink-0 flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-bold transition ${
                  active ? "bg-violet-600 text-white" : "border border-slate-200 bg-white text-slate-600"
                }`}
              >
                {!active && tab.dot && (
                  <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: tab.dot }} />
                )}
                {tab.label}
                <span className={`text-[10px] ${active ? "opacity-80" : "text-slate-400"}`}>({tab.count})</span>
              </button>
            );
          })}
        </div>

        {/* Search (All tab only) */}
        {taskTab === "all" && (
          <div className="shrink-0 border-b border-slate-200 px-4 py-2">
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input
                value={taskSearchQuery}
                onChange={(e) => setTaskSearchQuery(e.target.value)}
                data-testid="task-search-input"
                placeholder="Search tasks..."
                className="flex-1 bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400"
              />
            </div>
          </div>
        )}

        {/* Task list */}
        <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {activeTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <span className="mb-3 text-4xl">{taskTab === "done" ? "✅" : taskTab === "missed" ? "🎉" : "📋"}</span>
              <p className="text-[14px] font-semibold text-slate-700">
                {taskTab === "done" ? "No completed tasks" : taskTab === "missed" ? "No missed tasks!" : "No tasks here"}
              </p>
              <p className="mt-1 text-[12px] text-slate-400">Tap + Task to create one.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {activeTasks.map((task) => (
                <TaskListCard
                  key={task.id}
                  task={task}
                  reminders={reminders}
                  onEditTask={onEditTask}
                  onToggleStatus={onToggleStatus}
                  onDeleteTask={onDeleteTask}
                  onCreateLinkedReminder={onCreateLinkedReminder}
                  onReminderMarkDone={onReminderMarkDone}
                  onReminderEdit={onReminderEdit}
                  onReminderReschedule={onReminderReschedule}
                  onReminderDelete={onReminderDelete}
                />
              ))}
            </div>
          )}

          {/* FAB */}
          <button
            type="button"
            onClick={onCreateTask}
            data-testid="task-fab-button"
            className="fixed bottom-20 right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-teal-500 text-white shadow-lg shadow-teal-500/40 transition hover:bg-teal-400 active:scale-95 lg:hidden"
            aria-label="New task"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {/* Footer: view reminders */}
        <div className="shrink-0 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onViewReminders}
            data-testid="task-panel-view-reminders"
            className="text-[12px] font-semibold text-violet-600"
          >
            View reminders →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TaskFormOverlay ──────────────────────────────────────────────────────────

export function TaskFormOverlay({
  open,
  editingTaskId,
  taskFormTitle,
  setTaskFormTitle,
  taskFormDue,
  setTaskFormDue,
  taskFormNotes,
  setTaskFormNotes,
  taskFormDomain,
  setTaskFormDomain,
  taskStars,
  setTaskStars,
  taskFormError,
  setTaskFormError,
  setTaskDueUserEdited,
  onSubmit,
  onCancelEdit,
  onClose,
  onViewReminders,
  onCreateLinkedReminder,
}: TaskFormOverlayProps) {
  if (!open) return null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!taskFormTitle.trim()) {
      event.preventDefault();
      setTaskFormError("Task title is required.");
      return;
    }
    if (taskStars < 1 || taskStars > 5) {
      event.preventDefault();
      setTaskFormError("Choose a priority: tap 1–5 stars.");
      return;
    }
    onSubmit(event);
  };

  // Parse date and time from taskFormDue (datetime-local format: YYYY-MM-DDTHH:MM)
  const dueDatePart = taskFormDue ? taskFormDue.split("T")[0] : "";
  const dueTimePart = taskFormDue ? taskFormDue.split("T")[1] : "";
  const dueDateDisplay = dueDatePart
    ? new Date(`${dueDatePart}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "Not set";
  const dueTimeDisplay = dueTimePart
    ? new Date(`1970-01-01T${dueTimePart}`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "Optional";

  const domainChipColors: Record<string, { active: string; text: string }> = {
    health:  { active: "#10b981", text: "#065f46" },
    finance: { active: "#06b6d4", text: "#155e75" },
    career:  { active: "#6366f1", text: "#312e81" },
    hobby:   { active: "#7c3aed", text: "#4c1d95" },
    fun:     { active: "#f59e0b", text: "#78350f" },
  };

  return (
    <div
      data-testid="task-form-overlay"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tasks-form-title"
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Handle bar */}
        <div className="flex shrink-0 justify-center pt-2.5 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-slate-200" />
        </div>

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-5 py-3">
          {editingTaskId ? (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1 text-slate-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="m15 18-6-6 6-6"/></svg>
              <span className="text-[15px] font-semibold text-slate-700">Edit Task</span>
            </button>
          ) : (
            <h3 id="tasks-form-title" className="text-[17px] font-extrabold text-slate-900">New Task</h3>
          )}
          <div className="flex items-center gap-2">
            {editingTaskId && (
              <button
                type="button"
                onClick={onCancelEdit}
                data-testid="task-cancel-edit-button"
                className="text-[12px] font-semibold text-slate-400 underline"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-400"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <form id="task-form" className="min-h-0 flex-1 overflow-y-auto" onSubmit={handleSubmit}>
          <div className="grid gap-5 px-5 pb-6 pt-1">

            {/* Task name input */}
            <input
              value={taskFormTitle}
              onChange={(e) => setTaskFormTitle(e.target.value)}
              placeholder="Task name..."
              data-testid="task-title-input"
              className="w-full border-0 border-b-2 border-teal-400 pb-2 text-[15px] font-medium text-slate-900 outline-none placeholder:text-slate-400"
              autoFocus
            />

            {/* Due date + time chips */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">DUE DATE</p>
                <div className="relative">
                  <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <span className="text-[13px] font-semibold text-slate-700">{dueDateDisplay}</span>
                  </div>
                  <input
                    type="date"
                    min={new Date().toISOString().slice(0, 10)}
                    value={dueDatePart}
                    onChange={(e) => {
                      setTaskDueUserEdited(true);
                      setTaskFormDue(`${e.target.value}T${dueTimePart || "09:00"}`);
                    }}
                    data-testid="task-due-input"
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">TIME</p>
                <div className="relative">
                  <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <span className="text-[13px] font-semibold text-slate-500">{dueTimeDisplay}</span>
                  </div>
                  <input
                    type="time"
                    value={dueTimePart}
                    onChange={(e) => {
                      setTaskDueUserEdited(true);
                      setTaskFormDue(`${dueDatePart || new Date().toISOString().slice(0, 10)}T${e.target.value}`);
                    }}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </div>
              </div>
            </div>

            {/* Priority stars */}
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                PRIORITY <span className="text-rose-400">*</span>
              </p>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setTaskStars(n)}
                    className={`flex h-11 w-11 items-center justify-center rounded-2xl border text-xl transition ${
                      n <= taskStars
                        ? "border-amber-300 bg-amber-50 text-amber-400"
                        : "border-slate-200 bg-slate-50 text-slate-300"
                    }`}
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            {/* Domain chips */}
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">DOMAIN</p>
              <div className="flex flex-wrap gap-2">
                {(["health", "finance", "career", "hobby", "fun"] as const).map((d) => {
                  const active = taskFormDomain === d;
                  const c = domainChipColors[d]!;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setTaskFormDomain(active ? "" : d)}
                      data-testid="task-domain-select"
                      className="rounded-full px-4 py-1.5 text-[12px] font-bold transition"
                      style={
                        active
                          ? { background: `${c.active}20`, color: c.active, border: `1.5px solid ${c.active}` }
                          : { background: "#f8fafc", color: "#64748b", border: "1.5px solid #e2e8f0" }
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Notes */}
            <input
              value={taskFormNotes}
              onChange={(e) => setTaskFormNotes(e.target.value)}
              placeholder="Notes (optional)..."
              data-testid="task-notes-input"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-[13px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-teal-400"
            />

            {/* Error */}
            {taskFormError && (
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-600" data-testid="task-form-error">
                {taskFormError}
              </p>
            )}

            {/* Save & add linked reminder */}
            <button
              type="button"
              onClick={onCreateLinkedReminder}
              data-testid="task-create-linked-reminder-button"
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-300 bg-violet-50 py-3 text-[13px] font-bold text-violet-700"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
              Save &amp; add linked reminder
            </button>

            {/* Save Task */}
            <button
              type="submit"
              data-testid="task-save-button"
              className="w-full rounded-2xl bg-teal-500 py-3.5 text-[15px] font-bold text-white shadow-md shadow-teal-500/30"
            >
              {editingTaskId ? "Save Changes" : "Save Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
