/**
 * Typed audit-action constants. Every admin endpoint that
 * mutates state should call `recordAuditEvent` with one of these strings.
 *
 * Adding a new admin action? Add a new constant here FIRST. The type
 * derivation makes typos impossible at compile time.
 */

export const AUDIT_ACTIONS = [
  // role / lifecycle
  "ROLE_CHANGED",
  "DISPLAY_ROLE_CHANGED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "USER_HARD_DELETED",
  "USER_SESSIONS_REVOKED",
  // chat / data
  "CHAT_HISTORY_RESET",
  // broadcasts
  "BROADCAST_SENT",
  "BROADCAST_RECALLED",
  // direct messages and notes
  "USER_DM_SENT",
  "ADMIN_NOTE_CREATED",
  "ADMIN_NOTE_EDITED",
  "ADMIN_NOTE_DELETED",
  // bulk operations
  "BULK_DEACTIVATION_REQUESTED",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Returns true iff the supplied string is a known audit action.
 * Useful for runtime validation (e.g. accepting a filter from the UI).
 */
export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** Audit row shape forwarded to admin UIs. */
export interface AuditLogEntry {
  id: string;
  actorUserId: string;
  /** Display name resolved from Clerk at read-time (best effort). */
  actorDisplay: string;
  actorRole: "admin";
  action: AuditAction;
  targetUserId?: string;
  /** Display name of target, when resolvable. */
  targetDisplay?: string;
  /** Parsed JSON. Shape depends on the action. */
  metadata?: unknown;
  outcome: "ok" | "error";
  errorMessage?: string;
  createdAt: number;
}

/** Audit row shape returned to the broadcasts list UI. */
export interface BroadcastListItem {
  id: string;
  senderUserId: string;
  senderDisplay: string;
  senderRole: "admin";
  title: string;
  body: string;
  segment: "all" | "active_today" | "active_7d" | "admins_only";
  recipientCount: number;
  recalledAt: number | null;
  recalledBy: string | null;
  recalledByDisplay: string | null;
  createdAt: number;
}

/** Body shape for `POST /api/admin/broadcasts`. */
export interface SendBroadcastRequest {
  title: string;
  body: string;
  segment: BroadcastListItem["segment"];
}

/** Admin note row forwarded to the user-detail page. */
export interface AdminNote {
  id: string;
  targetUserId: string;
  authorUserId: string;
  authorDisplay: string;
  /** Role of the admin who authored this note. */
  authorRole: "admin";
  content: string;
  createdAt: number;
  updatedAt: number;
  /** True iff the current viewer is allowed to edit/delete this note. */
  canEdit: boolean;
}

/** Body shape for `POST /api/admin/users/[userId]/notes`. */
export interface CreateAdminNoteRequest {
  content: string;
}

/** Body shape for `PATCH /api/admin/notes/[noteId]`. */
export interface UpdateAdminNoteRequest {
  content: string;
}

/** Body shape for `POST /api/admin/users/[userId]/message`. */
export interface SendDirectMessageRequest {
  title: string;
  body: string;
}

/** Body shape for `POST /api/admin/users/bulk-deactivate`. */
export interface BulkDeactivateRequest {
  userIds: string[];
  deactivated: boolean;
}

export interface BulkDeactivateResult {
  ok: boolean;
  results: Array<{
    userId: string;
    success: boolean;
    error?: string;
  }>;
}

export interface OrgCostOverview {
  totalUsers: number;
  /** Sum of token estimates across the entire user base. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** USD using configured / default rates. */
  estimatedCostUsd: number;
  /** Top 10 spenders by total tokens. */
  topSpenders: Array<{
    userId: string;
    display: string;
    totalTokens: number;
    estimatedCostUsd: number;
  }>;
}
