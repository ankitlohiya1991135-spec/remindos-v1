/**
 * Typed audit-action constants. Every admin/superadmin endpoint that
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
  actorRole: "admin" | "superadmin";
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
  senderRole: "admin" | "superadmin";
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
