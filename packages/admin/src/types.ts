/**
 * @repo/admin — type definitions and Clerk metadata augmentation.
 *
 * This file declares the canonical shape of `publicMetadata` for ALL Clerk
 * users in this monorepo. Importing anything from `@repo/admin` (directly or
 * transitively) makes `user.publicMetadata.userType` strongly typed across
 * the entire app — no `as "admin"` casts needed anywhere.
 */

/** Canonical role values stored on Clerk `publicMetadata.userType`. */
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
    userType?: UserRole;
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
  role: UserRole;
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
}

/** Standard error payload shape returned by admin API routes. */
export interface AdminApiError {
  error: string;
  code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "INTERNAL";
}

// Required for the `declare global` block to be picked up as augmentation.
export {};
