"use client";

/**
 * use-task-form-state.ts
 *
 * Manages all task form state, task CRUD operations, and related callbacks.
 * Extracted from dashboard-workspace.tsx to reduce its line count.
 */

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  type FormEvent,
} from "react";
import type { ReminderItem } from "@repo/reminder";
import type { TaskRow } from "./task-panels";
import type { LifeDomain } from "@repo/reminder";
import {
  currentDateTimeLocalValue,
  toDateTimeLocalValue,
} from "./dashboard-utils";
import type { TaskActionWarning } from "./dashboard-types";

export interface UseTaskFormStateParams {
  reminders: ReminderItem[];
  refreshReminders: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  showShareToast: (msg: string) => void;
  showCreateOverlay: (opts?: { linkedTaskId?: string }) => void;
  setIsTasksOpen: (v: boolean) => void;
  setTaskMode: Dispatch<SetStateAction<"browse" | "create">>;
  taskActionWarning: TaskActionWarning | null;
  setTaskActionWarning: Dispatch<SetStateAction<TaskActionWarning | null>>;
  resetTaskFormRef: MutableRefObject<() => void>;
}

export function useTaskFormState({
  reminders,
  refreshReminders,
  refreshTasks,
  showShareToast,
  showCreateOverlay,
  setIsTasksOpen,
  setTaskMode,
  taskActionWarning,
  setTaskActionWarning,
  resetTaskFormRef,
}: UseTaskFormStateParams) {
  // ─── Form state ───────────────────────────────────────────────────────────
  const [taskFormTitle, setTaskFormTitle] = useState("");
  const [taskFormDue, setTaskFormDue] = useState(() => currentDateTimeLocalValue());
  const [taskFormNotes, setTaskFormNotes] = useState("");
  const [taskFormError, setTaskFormError] = useState<string | null>(null);
  const [taskStars, setTaskStars] = useState(0);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskFormDomain, setTaskFormDomain] = useState<"" | LifeDomain>("");
  /** False until user focuses/changes due — then live "now" updates stop for new tasks. */
  const [taskDueUserEdited, setTaskDueUserEdited] = useState(false);

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const getPendingLinkedReminderCount = useCallback(
    (taskId: string) =>
      reminders.filter(
        (r) => r.linkedTaskId === taskId && r.status === "pending",
      ).length,
    [reminders],
  );

  const executeTaskStatusToggle = useCallback(
    async (task: TaskRow) => {
      try {
        await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: task.status === "done" ? "pending" : "done",
          }),
        });
        await refreshTasks();
      } catch {
        setTaskFormError("Could not update task. Try again.");
      }
    },
    [refreshTasks],
  );

  const executeTaskDelete = useCallback(
    async (task: TaskRow) => {
      try {
        const response = await fetch(`/api/tasks/${task.id}`, {
          method: "DELETE",
        });
        const data = (await response.json().catch(() => ({}))) as {
          unlinkedReminderCount?: number;
        };
        await refreshTasks();
        await refreshReminders();
        if ((data.unlinkedReminderCount ?? 0) > 0) {
          showShareToast(
            `Deleted "${task.title}" and kept ${data.unlinkedReminderCount} reminder${
              data.unlinkedReminderCount === 1 ? "" : "s"
            } as ADHOC.`,
          );
        }
      } catch {
        setTaskFormError("Could not delete task. Try again.");
      }
    },
    [refreshReminders, refreshTasks, showShareToast],
  );

  const requestTaskStatusToggle = useCallback(
    (task: TaskRow) => {
      const pendingReminderCount = getPendingLinkedReminderCount(task.id);
      if (task.status === "pending" && pendingReminderCount > 0) {
        setTaskActionWarning({
          task,
          action: "complete",
          pendingReminderCount,
        });
        return;
      }
      void executeTaskStatusToggle(task);
    },
    [executeTaskStatusToggle, getPendingLinkedReminderCount, setTaskActionWarning],
  );

  const requestTaskDelete = useCallback(
    (task: TaskRow) => {
      const pendingReminderCount = getPendingLinkedReminderCount(task.id);
      if (pendingReminderCount > 0) {
        setTaskActionWarning({
          task,
          action: "delete",
          pendingReminderCount,
        });
        return;
      }
      void executeTaskDelete(task);
    },
    [executeTaskDelete, getPendingLinkedReminderCount, setTaskActionWarning],
  );

  const confirmTaskWarning = useCallback(() => {
    if (!taskActionWarning) return;
    const { action, task } = taskActionWarning;
    setTaskActionWarning(null);
    if (action === "complete") {
      void executeTaskStatusToggle(task);
      return;
    }
    void executeTaskDelete(task);
  }, [executeTaskDelete, executeTaskStatusToggle, taskActionWarning, setTaskActionWarning]);

  // ─── Form operations ──────────────────────────────────────────────────────
  const resetTaskForm = useCallback(() => {
    setTaskFormTitle("");
    setTaskFormDue(currentDateTimeLocalValue());
    setTaskFormNotes("");
    setTaskStars(3);
    setEditingTaskId(null);
    setTaskFormError(null);
    setTaskFormDomain("");
    setTaskDueUserEdited(false);
  }, []);

  // Sync the ref so the overlay hook can call resetTaskForm via resetTaskFormRef
  resetTaskFormRef.current = resetTaskForm;

  const openTaskEdit = useCallback(
    (task: TaskRow) => {
      setTaskMode("create");
      setEditingTaskId(task.id);
      setTaskFormTitle(task.title);
      setTaskFormNotes(task.notes ?? "");
      setTaskFormDue(toDateTimeLocalValue(task.dueAt));
      setTaskDueUserEdited(true);
      setTaskStars(
        typeof task.priority === "number" &&
          task.priority >= 1 &&
          task.priority <= 5
          ? task.priority
          : 0,
      );
      setTaskFormDomain(task.domain ?? "");
      setTaskFormError(null);
      setIsTasksOpen(true);
    },
    [setIsTasksOpen, setTaskMode],
  );

  const handleTaskSave = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!taskFormTitle.trim()) {
        const message = "Task title is required.";
        setTaskFormError(message);
        showShareToast(message);
        return;
      }
      if (taskStars < 1 || taskStars > 5) {
        const message = "Choose a priority: tap 1–5 stars.";
        setTaskFormError(message);
        showShareToast(message);
        return;
      }
      setTaskFormError(null);
      let dueAt: number | undefined;
      if (taskFormDue.trim()) {
        const ms = new Date(taskFormDue).getTime();
        if (!Number.isFinite(ms)) {
          setTaskFormError("Invalid date or time.");
          return;
        }
        dueAt = ms;
      }
      try {
        const payload: Record<string, unknown> = {
          title: taskFormTitle.trim(),
          notes: taskFormNotes.trim() ? taskFormNotes.trim() : undefined,
          dueAt,
          priority: taskStars,
        };
        if (editingTaskId) {
          payload.domain = taskFormDomain || null;
        } else if (taskFormDomain) {
          payload.domain = taskFormDomain;
        }
        const res = editingTaskId
          ? await fetch(`/api/tasks/${editingTaskId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch("/api/tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setTaskFormError(data.error ?? "Could not save task.");
          return;
        }
        resetTaskForm();
        await refreshTasks();
      } catch {
        setTaskFormError("Network error. Try again.");
      }
    },
    [
      taskFormTitle, taskStars, taskFormDue, taskFormNotes, editingTaskId,
      taskFormDomain, refreshTasks, showShareToast, resetTaskForm,
    ],
  );

  const startReminderForCurrentTask = useCallback(async () => {
    if (!taskFormTitle.trim()) {
      setTaskFormError("Add a task title first.");
      return;
    }
    if (taskStars < 1 || taskStars > 5) {
      setTaskFormError("Choose priority: tap 1–5 stars.");
      return;
    }
    setTaskFormError(null);
    let dueAt: number | undefined;
    if (taskFormDue.trim()) {
      const ms = new Date(taskFormDue).getTime();
      if (!Number.isFinite(ms)) {
        setTaskFormError("Invalid due date or time.");
        return;
      }
      dueAt = ms;
    }
    try {
      let taskId = editingTaskId;
      if (!taskId) {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: taskFormTitle.trim(),
            notes: taskFormNotes.trim() ? taskFormNotes.trim() : undefined,
            dueAt,
            priority: taskStars,
            status: "pending",
            ...(taskFormDomain ? { domain: taskFormDomain } : {}),
          }),
        });
        const data = (await res.json()) as {
          task?: { _id?: string };
          error?: string;
        };
        if (!res.ok) {
          setTaskFormError(data.error ?? "Could not save task.");
          return;
        }
        const tid = data.task?._id;
        if (!tid) {
          setTaskFormError("Task saved but missing id.");
          return;
        }
        taskId = String(tid);
        setEditingTaskId(taskId);
        await refreshTasks();
      }
      showCreateOverlay({ linkedTaskId: taskId });
    } catch {
      setTaskFormError("Network error. Try again.");
    }
  }, [
    editingTaskId, taskFormTitle, taskFormDue, taskFormNotes,
    taskStars, taskFormDomain, refreshTasks, showCreateOverlay,
  ]);

  // ─── Return ───────────────────────────────────────────────────────────────
  return {
    taskFormTitle,
    setTaskFormTitle,
    taskFormDue,
    setTaskFormDue,
    taskFormNotes,
    setTaskFormNotes,
    taskFormError,
    setTaskFormError,
    taskStars,
    setTaskStars,
    editingTaskId,
    setEditingTaskId,
    taskFormDomain,
    setTaskFormDomain,
    taskDueUserEdited,
    setTaskDueUserEdited,
    getPendingLinkedReminderCount,
    executeTaskStatusToggle,
    executeTaskDelete,
    requestTaskStatusToggle,
    requestTaskDelete,
    confirmTaskWarning,
    resetTaskForm,
    openTaskEdit,
    handleTaskSave,
    startReminderForCurrentTask,
  } as const;
}
