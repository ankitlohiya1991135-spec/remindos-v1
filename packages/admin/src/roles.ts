/**
 * Pure role helpers. No Clerk / Next.js imports — safe to use from any
 * environment (Convex, Node, browser).
 */

import { DEFAULT_USER_ROLE, USER_ROLES, type UserRole } from "./types";

/**
 * Coerce an unknown value (e.g. raw `publicMetadata.userType`) into a
 * known `UserRole`. Falls back to `DEFAULT_USER_ROLE` for unknown / missing.
 */
export function coerceUserRole(value: unknown): UserRole {
  if (typeof value !== "string") return DEFAULT_USER_ROLE;
  return (USER_ROLES as readonly string[]).includes(value)
    ? (value as UserRole)
    : DEFAULT_USER_ROLE;
}

/**
 * Read the real, access-controlling role from Clerk publicMetadata.
 * NEVER use any display override for authorization — only `userType` is
 * authoritative.
 */
export function getRoleFromPublicMetadata(
  publicMetadata: { userType?: unknown } | null | undefined,
): UserRole {
  if (!publicMetadata) return DEFAULT_USER_ROLE;
  return coerceUserRole(publicMetadata.userType);
}

/**
 * Compute the role to display in admin UIs.
 * Returns the real role from publicMetadata.
 */
export function getDisplayRole(
  publicMetadata: { userType?: unknown } | null | undefined,
): UserRole {
  return getRoleFromPublicMetadata(publicMetadata);
}

/** Exact-match: is this role exactly `admin`? */
export function isAdminRole(role: UserRole): boolean {
  return role === "admin";
}

/**
 * Authorization helper: can this role access the admin section?
 * True only for `admin`.
 */
export function canAccessAdmin(role: UserRole): boolean {
  return role === "admin";
}

/**
 * Read the deactivated flag (UI/audit signal). Hard enforcement is via
 * Clerk's `banned` field — see `server.ts` for the combined check.
 */
export function isDeactivatedFromMetadata(
  publicMetadata: { deactivated?: unknown } | null | undefined,
): boolean {
  return Boolean(publicMetadata?.deactivated);
}
