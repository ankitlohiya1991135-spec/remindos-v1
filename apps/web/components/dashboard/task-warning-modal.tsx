"use client";

/**
 * TaskWarningModal
 *
 * Confirmation dialog shown before deleting a task or marking it complete
 * when it has pending reminders.
 * Extracted from dashboard-workspace.tsx.
 */

import type { TaskActionWarning } from "./dashboard-types";

export interface TaskWarningModalProps {
  warning: TaskActionWarning;
  onConfirm: () => void;
  onDismiss: () => void;
}

export function TaskWarningModal({ warning, onConfirm, onDismiss }: TaskWarningModalProps) {
  return (
    <div
      data-testid="task-warning-modal"
      className="fixed inset-0 z-[54] flex items-end justify-center bg-black/50 p-3 sm:items-center sm:p-4"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-600 dark:text-amber-300">
            Warning
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {warning.action === "delete"
              ? "Delete task with pending reminders?"
              : "Close task with incomplete reminders?"}
          </h3>
        </div>
        <div className="grid gap-4 px-5 py-5">
          <p
            className="text-sm leading-6 text-slate-600 dark:text-slate-300"
            data-testid="task-warning-text"
          >
            {warning.action === "delete"
              ? `Deleting "${warning.task.title}" will unlink ${warning.pendingReminderCount} pending reminder${
                  warning.pendingReminderCount === 1 ? "" : "s"
                }. They will stay in your reminder list as ADHOC items.`
              : `"${warning.task.title}" still has ${warning.pendingReminderCount} incomplete reminder${
                  warning.pendingReminderCount === 1 ? "" : "s"
                }. Continue only if you still want to mark the task done.`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              data-testid="task-warning-confirm"
              className={`flex-1 rounded-full px-4 py-3 text-sm font-semibold text-white transition ${
                warning.action === "delete"
                  ? "bg-rose-600 hover:bg-rose-500"
                  : "bg-amber-600 hover:bg-amber-500"
              }`}
            >
              {warning.action === "delete" ? "Delete task" : "Mark task done"}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              data-testid="task-warning-cancel"
              className="rounded-full border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
