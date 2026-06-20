import type { LifeDomain } from "@repo/reminder";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderAgentActionType =
  | "create_reminder"
  | "create_reminder_series"
  | "list_reminders"
  | "mark_done"
  | "delete_reminder"
  | "reschedule_reminder"
  | "snooze_reminder"
  | "edit_reminder"
  | "bulk_action"
  | "clarify"
  | "pending_confirm"
  | "unknown"
  // ─── Task CRUD ──────────────────────────────────────────────────────────
  | "create_task"
  | "list_tasks"
  | "mark_task_done"
  | "delete_task"
  | "edit_task";

export interface ReminderAgentAction {
  type: ReminderAgentActionType;
  title?: string;
  dueAt?: string;
  notes?: string;
  priority?: number;
  domain?: LifeDomain;
  recurrence?: "none" | "daily" | "weekly" | "monthly";
  linkedTaskId?: string;
  targetTitle?: string;
  targetId?: string;
  scope?: "today" | "tomorrow" | "missed" | "done" | "pending" | "all" | "later" | "future";
  /** Only on pending_confirm: the action waiting for user confirmation */
  pendingType?: "mark_done" | "delete_reminder" | "edit_reminder" | "mark_task_done" | "delete_task" | "edit_task";
  /** Only on snooze_reminder: minutes to push the due time forward */
  delayMinutes?: number;
  /** Only on edit_reminder: new field values */
  newTitle?: string;
  newNotes?: string;
  newPriority?: number;          // 1–5
  newDomain?: LifeDomain | null; // null = clear domain
  newRecurrence?: "none" | "daily" | "weekly" | "monthly";
  newLinkedTaskId?: string | null; // null = delink from task
  /** Only on bulk_action / pending_confirm(bulk): operation and resolved IDs */
  bulkOperation?: "mark_done" | "delete";
  bulkTargetIds?: string[];
  /** Only on list_reminders: ordered IDs of what was shown, for multi-turn ordinal resolution */
  listedIds?: string[];
  /** Only on clarify (no-time create): suggested dueAt ISO from profile/domain analysis */
  suggestedDueAt?: string;
  /** Only on clarify (disambiguation): pending operation type so the client doesn't start the create wizard */
  pendingOp?: "mark_done" | "delete" | "reschedule" | "edit" | "snooze";
  /** Only on clarify (disambiguation): IDs of ambiguous reminder candidates */
  candidateIds?: string[];
  /** Only on clarify (reschedule disambiguation): the already-parsed new due date ISO string */
  pendingDueAt?: string;
  /** Only on clarify (edit disambiguation): which field is being edited */
  pendingField?: "title" | "notes" | "priority" | "domain" | "recurrence" | "linkedTaskId";
  /** Only on clarify (edit disambiguation): the new value for the field */
  pendingValue?: string;
  /** Only on clarify (snooze disambiguation): snooze delay in minutes */
  pendingDelayMinutes?: number;
  /** When true, the client must NOT execute this mutation — it renders a
   *  prefilled editable card and the user commits via Save (human-in-the-loop). */
  preview?: boolean;
  /** Only on create_reminder_series: the pre-generated occurrence due times (ISO). */
  seriesDueAts?: string[];
  /** Only on clarify (smart create): echoed back so the user's next message is
   *  treated as the answer to this one question (single round, then fall back). */
  clarifyForReminder?: { originalMessage: string };
}

export interface ReminderAgentResponse {
  reply: string;
  action: ReminderAgentAction;
}
