/**
 * Server-only admin auth helpers. Imports Clerk's server SDK — must NOT be
 * pulled into client bundles. The `@repo/admin/server` subpath export
 * enforces this.
 */

import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import {
  canAccessAdmin,
  getRoleFromPublicMetadata,
  isSuperadminRole,
} from "./roles";
import type { UserRole } from "./types";

/**
 * Result of an admin guard check (admin OR superadmin). Discriminated by
 * `ok` so callers can narrow safely without casts.
 *
 * The `role` field carries the REAL role (`"admin" | "superadmin"`) so
 * downstream code can branch — e.g. include `actualRole` in responses
 * only when `role === "superadmin"`.
 */
export type AdminGuardResult =
  | { ok: true; userId: string; role: "admin" | "superadmin" }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Result of a superadmin-only guard.
 */
export type SuperadminGuardResult =
  | { ok: true; userId: string; role: "superadmin" }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Authoritative admin check. Allows BOTH admin and superadmin. Always reads
 * the user's CURRENT publicMetadata from Clerk (not from session JWT claims
 * which require a Clerk dashboard JWT-template config and may be cached).
 *
 * Use this on every admin API route. Returns a discriminated result rather
 * than throwing so callers can choose the response shape.
 */
export async function checkAdminRequest(): Promise<AdminGuardResult> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, status: 401, reason: "Not signed in" };
  }
  const user = await currentUser();
  if (!user) {
    return { ok: false, status: 401, reason: "User record not found" };
  }
  const role = getRoleFromPublicMetadata(user.publicMetadata);
  if (!canAccessAdmin(role)) {
    return { ok: false, status: 403, reason: "Admin role required" };
  }
  // Type-safe narrowing: canAccessAdmin → role is "admin" | "superadmin".
  return { ok: true, userId, role: role as "admin" | "superadmin" };
}

/**
 * Strict guard: only superadmin passes. Admin returns 403. Use this on
 * destructive endpoints (role updates, deactivation) and superadmin-only
 * data exposure.
 */
export async function checkSuperadminRequest(): Promise<SuperadminGuardResult> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, status: 401, reason: "Not signed in" };
  }
  const user = await currentUser();
  if (!user) {
    return { ok: false, status: 401, reason: "User record not found" };
  }
  const role = getRoleFromPublicMetadata(user.publicMetadata);
  if (!isSuperadminRole(role)) {
    return { ok: false, status: 403, reason: "Superadmin role required" };
  }
  return { ok: true, userId, role: "superadmin" };
}

/**
 * Read the current viewer's role server-side without requiring admin.
 * Useful for layout/page rendering that branches on role.
 */
export async function getCurrentUserRole(): Promise<{
  userId: string | null;
  role: UserRole | null;
}> {
  const { userId } = await auth();
  if (!userId) return { userId: null, role: null };
  const user = await currentUser();
  if (!user) return { userId, role: null };
  return { userId, role: getRoleFromPublicMetadata(user.publicMetadata) };
}

/**
 * Count active (non-banned, non-deactivated) superadmins by paging
 * through Clerk users. Called only on demote / deactivate operations to
 * prevent the org from losing its last superadmin.
 *
 * Caps at 5000 users for sanity; if you have more, increase or move to
 * a Convex `roleRegistry` table maintained on every role change.
 */
export async function countActiveSuperadmins(): Promise<number> {
  const client = await clerkClient();
  const PAGE = 200;
  const HARD_CAP = 5000;
  let offset = 0;
  let count = 0;
  while (offset < HARD_CAP) {
    const res = await client.users.getUserList({ limit: PAGE, offset });
    for (const u of res.data) {
      const role = getRoleFromPublicMetadata(u.publicMetadata);
      const deactivatedFlag = Boolean(u.publicMetadata?.deactivated);
      const banned = Boolean((u as { banned?: boolean }).banned);
      if (role === "superadmin" && !deactivatedFlag && !banned) {
        count++;
      }
    }
    if (res.data.length < PAGE) break;
    offset += PAGE;
  }
  return count;
}

/**
 * Returns the shared admin secret used to gate Convex admin queries.
 *
 * This MUST only be read on the trusted Next.js server (never in client
 * components or shipped to the browser). It defends against direct calls
 * to Convex public queries that bypass our Next.js role check.
 *
 * Throws if the secret is missing or too weak — fail closed.
 */
export function getAdminConvexSecret(): string {
  const secret = process.env.ADMIN_CONVEX_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "ADMIN_CONVEX_SECRET is missing or shorter than 16 chars. Set a strong random value (e.g. `openssl rand -hex 32`) in the server environment AND in the Convex dashboard.",
    );
  }
  return secret;
}
