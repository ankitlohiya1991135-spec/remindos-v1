import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { checkAdminRequest, getAdminConvexSecret } from "@repo/admin/server";
import { getRoleFromPublicMetadata } from "@repo/admin";
import type {
  AdminApiError,
  AdminUserActivity,
  UserRole,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * GET /api/admin/users/[userId]/activity
 *
 * Returns prompt counts, daily histogram, recent prompt previews, and
 * reminder/task totals for a single user. Admin-only.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const { userId } = await context.params;
  if (!userId || typeof userId !== "string") {
    return jsonError({ error: "userId is required", code: "BAD_REQUEST" }, 400);
  }

  try {
    // Validate the userId actually exists in Clerk before exposing data.
    const client = await clerkClient();
    let clerkUser;
    try {
      clerkUser = await client.users.getUser(userId);
    } catch {
      return jsonError({ error: "User not found", code: "BAD_REQUEST" }, 404);
    }

    const convex = getConvexClient();
    const activity = (await convex.query(api.admin.userActivityDetail, {
      userId,
      adminSecret: getAdminConvexSecret(),
    })) as AdminUserActivity;

    const role: UserRole = getRoleFromPublicMetadata(clerkUser.publicMetadata);

    return NextResponse.json({
      user: {
        id: clerkUser.id,
        email: clerkUser.primaryEmailAddress?.emailAddress ?? "",
        firstName: clerkUser.firstName ?? "",
        lastName: clerkUser.lastName ?? "",
        username: clerkUser.username ?? "",
        imageUrl: clerkUser.imageUrl,
        role,
        createdAt: clerkUser.createdAt ?? 0,
        lastSignInAt: clerkUser.lastSignInAt ?? null,
      },
      activity,
    });
  } catch (err) {
    return jsonError({ error: errorMessage(err), code: "INTERNAL" }, 500);
  }
}
