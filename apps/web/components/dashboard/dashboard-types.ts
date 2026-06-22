/**
 * dashboard-types.ts
 *
 * All TypeScript interfaces and types shared across the dashboard
 * components. Centralising them here keeps dashboard-workspace.tsx
 * focused on runtime logic rather than type bookkeeping.
 */

import type { BriefingSection } from "@repo/reminder";
import type { TaskRow } from "./task-panels";

// ─── Chat ─────────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "system";

export interface ChatReplyToRef {
  id: string;
  content: string;
  role: ChatRole;
}

export interface ChatMessageMeta {
  kind?: "due_reminder" | "briefing" | "opening_summary" | "reminder_card" | "disambig_picker";
  /** Which slice of the session briefing this bubble is (split messages). */
  briefingSection?: BriefingSection;
  reminderId?: string;
  dueAt?: number;
  title?: string;
  notes?: string;
  /** When true, message is not written to chat history file */
  skipPersist?: boolean;
  replyTo?: ChatReplyToRef;
  editedAt?: string;
  /** For kind === "reminder_card": IDs of reminders to render as interactive cards (capped at 5). */
  reminderIds?: string[];
  /** Total count before the 5-card cap — used to show "+X more" button. */
  totalListedCount?: number;
  /** For an operation preview: which mode the card should open in (prefilled).
   *  Undefined = default mode (Done/Delete/Snooze buttons). */
  cardMode?: "reschedule" | "edit";
  /** Prefilled values for the editable card when opened from a chat operation. */
  cardPrefill?: {
    dueAt?: string;
    title?: string;
    notes?: string;
    priority?: number;
    domain?: string | null;
    recurrence?: "none" | "daily" | "weekly" | "monthly";
  };
  /** For kind === "disambig_picker": the ambiguous candidate reminder IDs to display. */
  disambigCandidateIds?: string[];
  /** Which CRUD operation is pending after the user picks. */
  disambigOp?: "mark_done" | "delete" | "reschedule" | "edit" | "snooze";
  /** Carried-forward context per op — mirrors PendingDisambig fields. */
  disambigPendingDueAt?: string;
  disambigPendingField?: "title" | "notes" | "priority" | "domain" | "recurrence" | "linkedTaskId";
  disambigPendingValue?: string;
  disambigPendingDelayMinutes?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  meta?: ChatMessageMeta;
}

// ─── Agent actions ─────────────────────────────────────────────────────────

export interface AgentAction {
  type:
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
    /** Fired by DisambigPickerCard when the user taps a candidate reminder.
     *  Carries targetId (selected) + pendingOp + any op-specific context. */
    | "resolve_disambig"
    // ─── Task CRUD ─────────────────────────────────────────────────────────
    | "create_task"
    | "list_tasks"
    | "mark_task_done"
    | "delete_task"
    | "edit_task";
  title?: string;
  dueAt?: string;
  notes?: string;
  linkedTaskId?: string;
  priority?: number;
  domain?: string;
  recurrence?: string;
  pendingType?: "mark_done" | "delete_reminder" | "edit_reminder" | "mark_task_done" | "delete_task" | "edit_task";
  delayMinutes?: number;
  newTitle?: string;
  newNotes?: string;
  /** Only on edit_reminder: new field values beyond title/notes */
  newPriority?: number;
  newDomain?: string | null;
  newRecurrence?: "none" | "daily" | "weekly" | "monthly";
  newLinkedTaskId?: string | null;
  /** Only on edit_reminder: change the reminder's status (e.g. restore a done reminder to pending). */
  newStatus?: "pending" | "done" | "archived";
  /** When true, the client must NOT execute this action. Instead it renders a
   *  prefilled editable card (micro front-end) and waits for the user to Save.
   *  Used to keep all chat mutations human-in-the-loop. */
  preview?: boolean;
  bulkOperation?: "mark_done" | "delete";
  bulkTargetIds?: string[];
  listedIds?: string[];
  suggestedDueAt?: string;
  targetTitle?: string;
  targetId?: string;
  scope?: "today" | "tomorrow" | "missed" | "done" | "pending" | "all" | "later" | "future";
  /** Only on clarify (disambiguation): pending operation type */
  pendingOp?: "mark_done" | "delete" | "reschedule" | "edit" | "snooze";
  /** Only on clarify (disambiguation): IDs of ambiguous reminder candidates */
  candidateIds?: string[];
  /** Only on clarify (reschedule disambiguation): already-parsed new due date ISO */
  pendingDueAt?: string;
  /** Only on clarify (edit disambiguation): which field is being edited */
  pendingField?: "title" | "notes" | "priority" | "domain" | "recurrence" | "linkedTaskId";
  /** Only on clarify (edit disambiguation): the new field value */
  pendingValue?: string;
  /** Only on clarify (snooze disambiguation): snooze delay in minutes */
  pendingDelayMinutes?: number;
  /** Only on create_reminder_series: the pre-generated occurrence due times (ISO). */
  seriesDueAts?: string[];
  /** Only on clarify (smart create): echoed back so the next user message is the answer. */
  clarifyForReminder?: { originalMessage: string };
}

export interface AgentResponse {
  reply: string;
  action: AgentAction;
}

// ─── Overlays / UI state ───────────────────────────────────────────────────

export interface PendingCreateDraft {
  step: "title" | "date" | "time" | "task" | "priority";
  title?: string;
  notes?: string;
  dateIso?: string;
  dueAt?: string;
  linkedTaskId?: string;
  priority?: number;
}

export interface WorkspaceProps {
  userId: string;
}

export type DashboardOverlay =
  | "snapshot"
  | "create"
  | "reminders"
  | "tasks"
  | "share"
  | "import"
  | "batch";

export interface DashboardOverlayState {
  overlay: DashboardOverlay;
  taskMode?: "create" | "browse";
  shareReminderIds?: string[];
  reminderTab?: ReminderListTab;
}

export type ReminderListTab =
  | "all"
  | "missed"
  | "today"
  | "tomorrow"
  | "next2hours"
  | "upcoming"
  | "done"
  | "shared"
  | "sent";

// ─── Directory / sharing ───────────────────────────────────────────────────

export interface DirectoryUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  imageUrl: string;
}

export interface ShareInboxRow {
  _id: string;
  reminderId: string;
  token: string;
  fromUserId: string;
  fromDisplayName: string;
  toUserId: string;
  title: string;
  dueAt: number;
  createdAt: number;
  shareBatchId?: string;
}

// ─── Pending chat states ──────────────────────────────────────────────────

export interface PendingConfirmAction {
  type: "mark_done" | "delete_reminder" | "edit_reminder" | "mark_task_done" | "delete_task" | "edit_task";
  targetId?: string;
  targetTitle?: string;
  targetIds?: string[];
  newTitle?: string;
  newNotes?: string;
  newPriority?: number;
  newDomain?: string | null;
  newRecurrence?: "none" | "daily" | "weekly" | "monthly";
  newLinkedTaskId?: string | null;
}

export type PendingDisambig =
  | { op: "mark_done"; candidateIds: string[] }
  | { op: "delete"; candidateIds: string[] }
  | { op: "reschedule"; candidateIds: string[]; pendingDueAt: string }
  | { op: "edit"; candidateIds: string[]; pendingField: "title" | "notes" | "priority" | "domain" | "recurrence" | "linkedTaskId"; pendingValue: string }
  | { op: "snooze"; candidateIds: string[]; pendingDelayMinutes: number };

export interface PendingTimeSuggestion {
  title: string;
  suggestedDueAt: string;
  priority?: number;
  domain?: string;
  recurrence?: string;
}

// ─── Task warnings ─────────────────────────────────────────────────────────

export type TaskWarningAction = "delete" | "complete";

export interface TaskActionWarning {
  task: TaskRow;
  action: TaskWarningAction;
  pendingReminderCount: number;
}
