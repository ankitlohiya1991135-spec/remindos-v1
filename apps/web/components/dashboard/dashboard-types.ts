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
  kind?: "due_reminder" | "briefing" | "opening_summary";
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
    | "list_reminders"
    | "mark_done"
    | "delete_reminder"
    | "reschedule_reminder"
    | "snooze_reminder"
    | "edit_reminder"
    | "bulk_action"
    | "clarify"
    | "pending_confirm"
    | "unknown";
  title?: string;
  dueAt?: string;
  notes?: string;
  linkedTaskId?: string;
  priority?: number;
  domain?: string;
  recurrence?: string;
  pendingType?: "mark_done" | "delete_reminder" | "edit_reminder";
  delayMinutes?: number;
  newTitle?: string;
  newNotes?: string;
  /** Only on edit_reminder: new field values beyond title/notes */
  newPriority?: number;
  newDomain?: string | null;
  newRecurrence?: "none" | "daily" | "weekly" | "monthly";
  newLinkedTaskId?: string | null;
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
  type: "mark_done" | "delete_reminder" | "edit_reminder";
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
