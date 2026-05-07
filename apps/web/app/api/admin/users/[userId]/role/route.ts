import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkSuperadminRequest,
  countActiveSuperadmins,
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
 * Superadmin-only. Updates EITHER `userType` (real role) OR `displayRole`
 * (UI-only override) OR both.
 *
 * Safety rules:
 *   - Caller must be superadmin (auth check FIRST, before body parse).
 *   - Cannot change own userType (footgun — could lock you out mid-action).
 *   - Cannot demote the LAST active superadmin (prevents org lockout).
 *   - Display role is purely cosmetic; setting it has no auth impact.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  // 1. Auth FIRST.
  const guard = await checkSuperadminRequest();
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

  const wantsUserTypeChange = "userType" in body && body.userType !== undefined;
  const wantsDisplayRoleChange = "displayRole" in body;

  if (!wantsUserTypeChange && !wantsDisplayRoleChange) {
    return jsonError(
      { error: "Provide at least one of: userType, displayRole", code: "BAD_REQUEST" },
      400,
    );
  }

  if (wantsUserTypeChange && !isValidRoleString(body.userType)) {
    return jsonError(
      { error: `userType must be one of: ${USER_ROLES.join(", ")}`, code: "BAD_REQUEST" },
      400,
    );
  }

  // displayRole accepts null (clears the override) or a valid role string.
  if (
    wantsDisplayRoleChange &&
    body.displayRole !== null &&
    !isValidRoleString(body.displayRole)
  ) {
    return jsonError(
      {
        error: `displayRole must be null or one of: ${USER_ROLES.join(", ")}`,
        code: "BAD_REQUEST",
      },
      400,
    );
  }

  // 3. Self-protection.
  if (wantsUserTypeChange && targetUserId === guard.userId) {
    return jsonError(
      {
        error:
          "You cannot change your own userType. Ask another superadmin to do it.",
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

    // 4. Last-superadmin protection.
    if (
      wantsUserTypeChange &&
      currentRole === "superadmin" &&
      body.userType !== "superadmin"
    ) {
      const activeSupers = await countActiveSuperadmins();
      if (activeSupers <= 1) {
        return jsonError(
          {
            error:
              "Cannot demote the last active superadmin. Promote another user first.",
            code: "BAD_REQUEST",
          },
          400,
        );
      }
    }

    // 5. Build the merged publicMetadata patch (preserve other fields).
    const existing = target.publicMetadata ?? {};
    const next: Record<string, unknown> = { ...existing };

    if (wantsUserTypeChange) {
      next.userType = coerceUserRole(body.userType);
    }
    if (wantsDisplayRoleChange) {
      if (body.displayRole === null) {
        delete next.displayRole;
      } else {
        next.displayRole = coerceUserRole(body.displayRole);
      }
    }

    // Auto-mask: when promoting someone to superadmin, default their
    // displayRole to "admin" UNLESS the caller is explicitly setting one.
    // Honors the project rule that superadmin is ALWAYS hidden in UI.
    // Caller can subsequently set displayRole to anything (or null) but the
    // initial promotion never leaks the superadmin status.
    if (
      wantsUserTypeChange &&
      body.userType === "superadmin" &&
      !wantsDisplayRoleChange
    ) {
      next.displayRole = "admin";
    }

    await client.users.updateUserMetadata(targetUserId, {
      publicMetadata: next,
    });

    // Audit trail. Record AFTER the operation succeeded so the entry
    // reflects reality. If the audit write itself fails, the helper
    // logs to stderr and does not error the request.
    const convex = getConvexClient();
    if (wantsUserTypeChange) {
      await recordAuditEvent({
        actor: { userId: guard.userId, role: "superadmin" },
        action: "ROLE_CHANGED",
        targetUserId,
        metadata: {
          from: currentRole,
          to: next.userType,
        },
        convex,
        mutationRef: api.admin.appendAuditEvent,
      });
    }
    if (wantsDisplayRoleChange) {
      await recordAuditEvent({
        actor: { userId: guard.userId, role: "superadmin" },
        action: "DISPLAY_ROLE_CHANGED",
        targetUserId,
        metadata: {
          from: existing.displayRole ?? null,
          to: next.displayRole ?? null,
        },
        convex,
        mutationRef: api.admin.appendAuditEvent,
      });
    }

    return NextResponse.json({
      ok: true,
      userId: targetUserId,
      userType: next.userType ?? currentRole,
      displayRole: next.displayRole ?? null,
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
