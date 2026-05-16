import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  countActiveAdmins,
  recordAuditEvent,
} from "@repo/admin/server";
import {
  USER_ROLES,
  coerceUserRole,
  getRoleFromPublicMetadata,
} from "@repo/admin";
import type {
  AdminApiError,
  UpdateUserRoleRequest,
  UserRole,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

function isValidRoleString(v: unknown): v is UserRole {
  return typeof v === "string" && (USER_ROLES as readonly string[]).includes(v);
}

/**
 * POST /api/admin/users/[userId]/role
 *
 * Admin-only. Updates the user's `userType` (real role).
 *
 * Safety rules:
 *   - Caller must be admin (auth check FIRST, before body parse).
 *   - Cannot change own userType (footgun — could lock you out mid-action).
 *   - Cannot demote the LAST active admin (prevents org lockout).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  // 1. Auth FIRST.
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

  // 2. Parse + validate body.
  let body: UpdateUserRoleRequest;
  try {
    body = (await request.json()) as UpdateUserRoleRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  if (!isValidRoleString(body.userType)) {
    return jsonError(
      { error: `userType must be one of: ${USER_ROLES.join(", ")}`, code: "BAD_REQUEST" },
      400,
    );
  }

  // 3. Self-protection.
  if (targetUserId === guard.userId) {
    return jsonError(
      {
        error: "You cannot change your own role. Ask another admin to do it.",
        code: "BAD_REQUEST",
      },
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

    // 4. Last-admin protection.
    if (currentRole === "admin" && body.userType !== "admin") {
      const activeAdmins = await countActiveAdmins();
      if (activeAdmins <= 1) {
        return jsonError(
          {
            error: "Cannot demote the last active admin. Promote another user first.",
            code: "BAD_REQUEST",
          },
          400,
        );
      }
    }

    // 5. Apply the role change.
    const existing = target.publicMetadata ?? {};
    const next: Record<string, unknown> = { ...existing };
    next.userType = coerceUserRole(body.userType);

    await client.users.updateUserMetadata(targetUserId, {
      publicMetadata: next,
    });

    // Audit trail.
    const convex = getConvexClient();
    await recordAuditEvent({
      actor: { userId: guard.userId, role: "admin" },
      action: "ROLE_CHANGED",
      targetUserId,
      metadata: {
        from: currentRole,
        to: next.userType,
      },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({
      ok: true,
      userId: targetUserId,
      userType: next.userType,
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
