/**
 * @repo/admin — type definitions and Clerk metadata augmentation.
 *
 * This file declares the canonical shape of `publicMetadata` for ALL Clerk
 * users in this monorepo. Importing anything from `@repo/admin` (directly or
 * transitively) makes `user.publicMetadata.userType` strongly typed across
 * the entire app — no `as "admin"` casts needed anywhere.
 */

/**
 * Canonical role values stored on Clerk `publicMetadata.userType`.
 *
 * Hierarchy (highest → lowest privilege):
 *   admin → user
 */
export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Default role assumed when `publicMetadata.userType` is missing. */
export const DEFAULT_USER_ROLE: UserRole = "user";

declare global {
  /**
   * Clerk's `publicMetadata` shape for every user in this app.
   * Extend this interface here (not in app code) so the type is shared.
   */
  interface UserPublicMetadata {
    /** Real, access-controlling role. Defaults to "user" if absent. */
    userType?: UserRole;
    /**
     * Soft-deactivation marker set by an admin. We ALSO ban the user
     * via Clerk for hard enforcement; this flag is for UI/audit clarity
     * and survives even if a Clerk-level un-ban is performed.
     */
    deactivated?: boolean;
  }
}

/** Minimal user shape we forward to admin UIs (Clerk row + activity). */
export interface AdminListedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  imageUrl: string;
  /** The user's role. */
  role: UserRole;
  /** Banned in Clerk OR `deactivated: true` in publicMetadata. */
  deactivated: boolean;
  createdAt: number;
  lastSignInAt: number | null;
  /** Activity stats joined from Convex. */
  activity: {
    totalPrompts: number;       // number of "user" chat messages ever
    promptsLast24h: number;     // user prompts in last 24 hours
    promptsLast7d: number;      // user prompts in last 7 days
    activeToday: boolean;       // sent at least one prompt today (UTC)
    lastPromptAt: number | null;
  };
}

/** Per-prompt detail row shown on the user-detail page. */
export interface AdminUserPromptRow {
  clientId: string;
  role: "user" | "assistant" | "system";
  contentPreview: string;       // truncated for UI
  createdAt: number;
}

/** Aggregate activity payload for the user-detail page. */
export interface AdminUserActivity {
  userId: string;
  totalPrompts: number;
  promptsLast24h: number;
  promptsLast7d: number;
  remindersCreated: number;
  remindersCompleted: number;
  tasksCreated: number;
  tasksCompleted: number;
  recentPrompts: AdminUserPromptRow[];
  /** Per-day prompt counts for the last 14 days. */
  dailyPromptCounts: Array<{ date: string; count: number }>;
  /**
   * Rough token-count estimate from chat content alone. Does NOT include
   * the wiki + digest + JSON context the chat route appends per turn, so
   * real upstream usage is higher.
   */
  tokenEstimate: {
    inputTokens: number;       // sum across user/system messages
    outputTokens: number;      // sum across assistant messages
    totalTokens: number;
    estimatedCostUsd: number;  // input * inputRate + output * outputRate
  };
  /**
   * Privacy-safe usage timing — derived from anonymous heartbeat pings sent
   * while the user has the app open. Stores no content.
   */
  sessionStats: {
    totalActiveMs: number;
    activeMs24h: number;
    activeMs7d: number;
    sessionCount: number;
    lastSeenAt: number | null;
  };
  /** Recent notifications for this user. */
  recentNotifications?: Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    read: boolean;
    /** When the user clicked the push notification (for CTR). */
    clickedAt?: number;
    createdAt: number;
  }>;
  /** Notification click-through-rate — is messaging actually helping this user? */
  notificationCtr?: {
    sent: number;
    clicked: number;
    byType: Array<{ type: string; sent: number; clicked: number }>;
  };
  /** Recent reminders summary. */
  recentReminders?: Array<{
    id: string;
    title: string;
    status: string;
    dueAt: number;
    createdAt: number;
  }>;
}

/** Body shape for `POST /api/admin/users/[userId]/role`. */
export interface UpdateUserRoleRequest {
  /** Set the access-controlling role. */
  userType: UserRole;
}

/** Body shape for `POST /api/admin/users/[userId]/deactivate`. */
export interface DeactivateUserRequest {
  /** true → ban + flag; false → unban + clear flag. */
  deactivated: boolean;
}

/** Standard error payload shape returned by admin API routes. */
export interface AdminApiError {
  error: string;
  code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "INTERNAL";
}

// Re-export audit + token types so consumers can use the `@repo/admin/types`
// subpath as a single source of types.
export type {
  AdminNote,
  AuditAction,
  AuditLogEntry,
  BroadcastListItem,
  BulkDeactivateRequest,
  BulkDeactivateResult,
  CreateAdminNoteRequest,
  OrgCostOverview,
  SendBroadcastRequest,
  SendDirectMessageRequest,
  CreateUserReminderRequest,
  UpdateAdminNoteRequest,
} from "./audit";
export { AUDIT_ACTIONS, isAuditAction } from "./audit";

// Required for the `declare global` block to be picked up as augmentation.
export {};
