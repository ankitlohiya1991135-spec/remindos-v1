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
 * NEVER read `displayRole` for authorization — only `userType` is
 * authoritative.
 */
export function getRoleFromPublicMetadata(
  publicMetadata: { userType?: unknown } | null | undefined,
): UserRole {
  if (!publicMetadata) return DEFAULT_USER_ROLE;
  return coerceUserRole(publicMetadata.userType);
}

/**
 * Compute the role to display in admin UIs. Falls back to the real role
 * when no override is set. This is what admins see for every user; only
 * superadmin-aware endpoints additionally expose `actualRole`.
 */
export function getDisplayRole(
  publicMetadata: { userType?: unknown; displayRole?: unknown } | null | undefined,
): UserRole {
  if (!publicMetadata) return DEFAULT_USER_ROLE;
  if (typeof publicMetadata.displayRole === "string") {
    const coerced = coerceUserRole(publicMetadata.displayRole);
    // Only use displayRole if it parses to a valid role and isn't the
    // sentinel that would re-leak superadmin. Defensive — even though
    // superadmins set their own override, allow them to choose anything.
    return coerced;
  }
  return getRoleFromPublicMetadata(publicMetadata);
}

/** Exact-match: is this role exactly `admin`? */
export function isAdminRole(role: UserRole): boolean {
  return role === "admin";
}

/** Exact-match: is this role exactly `superadmin`? */
export function isSuperadminRole(role: UserRole): boolean {
  return role === "superadmin";
}

/**
 * Authorization helper: can this role access the admin section?
 * True for `admin` AND `superadmin`. Use this everywhere you previously
 * called `isAdminRole` for a permission check.
 */
export function canAccessAdmin(role: UserRole): boolean {
  return role === "admin" || role === "superadmin";
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
