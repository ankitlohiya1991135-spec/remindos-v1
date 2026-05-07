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
 * Type guard: extract the role from a Clerk-shaped object's `publicMetadata`.
 * Accepts either a full Clerk user (server) or a useUser() user (client).
 */
export function getRoleFromPublicMetadata(
  publicMetadata: { userType?: unknown } | null | undefined,
): UserRole {
  if (!publicMetadata) return DEFAULT_USER_ROLE;
  return coerceUserRole(publicMetadata.userType);
}

/** Returns true iff the resolved role is `admin`. */
export function isAdminRole(role: UserRole): boolean {
  return role === "admin";
}
