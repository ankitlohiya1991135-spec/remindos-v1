import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { checkAdminRequest, getAdminConvexSecret } from "@repo/admin/server";
import {
  getDisplayRole,
  getRoleFromPublicMetadata,
  isDeactivatedFromMetadata,
} from "@repo/admin";
import type { AdminApiError, AdminListedUser } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";

/** Cap the number of users we list per request — page on the client if needed. */
const MAX_USERS = 200;

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * GET /api/admin/users
 *
 * Returns up to `MAX_USERS` Clerk users. Superadmins also receive chat-activity
 * stats; admins receive empty activity so chat data stays hidden.
 */
export async function GET(request: Request) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_USERS)
    : MAX_USERS;

  // Did the caller pass the superadmin guard? If yes, expose actualRole.
  // Admins receive only `role` (= display role) so they cannot identify
  // hidden superadmins from the API response.
  const callerIsSuperadmin = guard.role === "superadmin";

  try {
    const client = await clerkClient();
    const res = await client.users.getUserList({ limit, orderBy: "-created_at" });

    const baseUsers = res.data.map((u) => {
      const realRole = getRoleFromPublicMetadata(u.publicMetadata);
      const displayRole = getDisplayRole(u.publicMetadata);
      const banned = Boolean((u as { banned?: boolean }).banned);
      const deactivated = banned || isDeactivatedFromMetadata(u.publicMetadata);
      return {
        id: u.id,
        email: u.primaryEmailAddress?.emailAddress ?? "",
        firstName: u.firstName ?? "",
        lastName: u.lastName ?? "",
        username: u.username ?? "",
        imageUrl: u.imageUrl,
        role: displayRole,
        ...(callerIsSuperadmin ? { actualRole: realRole } : {}),
        deactivated,
        createdAt: u.createdAt ?? 0,
        lastSignInAt: u.lastSignInAt ?? null,
      };
    });

    // Bulk-fetch chat activity only for superadmins. Admins can manage users
    // but must not see another user's chat metadata.
    // The shared secret prevents anyone with the public Convex URL from
    // calling this query directly.
    let activityMap: Record<string, AdminListedUser["activity"]> = {};
    if (callerIsSuperadmin && baseUsers.length > 0) {
      const convex = getConvexClient();
      activityMap = await convex.query(api.admin.activityForUsers, {
        userIds: baseUsers.map((u) => u.id),
        adminSecret: getAdminConvexSecret(),
      });
    }

    const users: AdminListedUser[] = baseUsers.map((u) => ({
      ...u,
      activity: activityMap[u.id] ?? {
        totalPrompts: 0,
        promptsLast24h: 0,
        promptsLast7d: 0,
        activeToday: false,
        lastPromptAt: null,
      },
    }));

    return NextResponse.json({
      users,
      totalCount: res.totalCount,
      limitApplied: limit,
      truncated: typeof res.totalCount === "number" && res.totalCount > users.length,
    });
  } catch (err) {
    return jsonError(
      { error: errorMessage(err), code: "INTERNAL" },
      500,
    );
  }
}
