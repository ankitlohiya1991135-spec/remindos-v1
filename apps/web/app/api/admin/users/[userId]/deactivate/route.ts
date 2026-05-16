import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  countActiveAdmins,
  recordAuditEvent,
} from "@repo/admin/server";
import { getRoleFromPublicMetadata } from "@repo/admin";
import type {
  AdminApiError,
  DeactivateUserRequest,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/[userId]/deactivate
 *
 * Admin-only. Soft + hard deactivation:
 *   - Sets `publicMetadata.deactivated = true` (audit signal)
 *   - Calls Clerk `banUser` (prevents future sign-in; existing sessions
 *     are invalidated by Clerk on next request)
 *
 * `deactivated: false` reverses both. Cannot deactivate self or the last
 * active admin.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const { userId: targetUserId } = await context.params;
  if (!targetUserId) {
    return jsonError({ error: "userId is required", code: "BAD_REQUEST" }, 400);
  }

  let body: DeactivateUserRequest;
  try {
    body = (await request.json()) as DeactivateUserRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  if (typeof body.deactivated !== "boolean") {
    return jsonError(
      { error: "Body must include `deactivated: boolean`", code: "BAD_REQUEST" },
      400,
    );
  }

  if (targetUserId === guard.userId) {
    return jsonError(
      { error: "You cannot deactivate your own account.", code: "BAD_REQUEST" },
      400,
    );
  }

  try {
    const client = await clerkClient();
    let target;
    try {
      target = await client.users.getUser(targetUserId);
    } catch {
      return jsonError({ error: "User not found", code: "BAD_REQUEST" }, 404);
    }

    const currentRole = getRoleFromPublicMetadata(target.publicMetadata);

    // Last-admin protection (only when deactivating).
    if (body.deactivated && currentRole === "admin") {
      const activeAdmins = await countActiveAdmins();
      if (activeAdmins <= 1) {
        return jsonError(
          {
            error: "Cannot deactivate the last active admin. Promote another user first.",
            code: "BAD_REQUEST",
          },
          400,
        );
      }
    }

    if (body.deactivated) {
      await client.users.banUser(targetUserId);
    } else {
      await client.users.unbanUser(targetUserId);
    }

    const existing = target.publicMetadata ?? {};
    const next: Record<string, unknown> = { ...existing };
    if (body.deactivated) next.deactivated = true;
    else delete next.deactivated;

    await client.users.updateUserMetadata(targetUserId, {
      publicMetadata: next,
    });

    await recordAuditEvent({
      actor: { userId: guard.userId, role: "admin" },
      action: body.deactivated ? "USER_DEACTIVATED" : "USER_REACTIVATED",
      targetUserId,
      metadata: { previousRole: currentRole },
      convex: getConvexClient(),
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({
      ok: true,
      userId: targetUserId,
      deactivated: body.deactivated,
    });
  } catch (err) {
    return jsonError(
      {
        error: err instanceof Error ? err.message : String(err),
        code: "INTERNAL",
      },
      500,
    );
  }
}
