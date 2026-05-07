/**
 * Server-only admin auth helpers. Imports Clerk's server SDK — must NOT be
 * pulled into client bundles. The `@repo/admin/server` subpath export
 * enforces this.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import { getRoleFromPublicMetadata, isAdminRole } from "./roles";
import type { UserRole } from "./types";

/**
 * Result of an admin guard check. Discriminated by `ok` so callers can
 * narrow safely without casts.
 */
export type AdminGuardResult =
  | { ok: true; userId: string; role: "admin" }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Authoritative admin check. Always reads the user's CURRENT publicMetadata
 * from Clerk (not from session JWT claims, which require a Clerk dashboard
 * JWT-template config and may be cached). Use this on every admin API route.
 *
 * Returns a discriminated result rather than throwing so callers can choose
 * the response shape (NextResponse.json, redirect, etc.).
 */
export async function checkAdminRequest(): Promise<AdminGuardResult> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, status: 401, reason: "Not signed in" };
  }
  // Fetch fresh — sessionClaims.publicMetadata is undefined unless the user
  // has configured a Clerk JWT template. Defaulting to the API call is the
  // safer cross-environment behaviour.
  const user = await currentUser();
  if (!user) {
    return { ok: false, status: 401, reason: "User record not found" };
  }
  const role = getRoleFromPublicMetadata(user.publicMetadata);
  if (!isAdminRole(role)) {
    return { ok: false, status: 403, reason: "Admin role required" };
  }
  return { ok: true, userId, role: "admin" };
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
