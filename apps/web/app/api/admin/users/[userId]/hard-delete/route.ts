import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkSuperadminRequest,
  countActiveSuperadmins,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import { getRoleFromPublicMetadata } from "@repo/admin";
import type { AdminApiError } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

interface HardDeleteRequest {
  /** Must equal the target user's email — typo guard. */
  confirmEmail: string;
  /** Must equal the literal string "DELETE" — guard against UI bug clicks. */
  confirmPhrase: string;
}

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/[userId]/hard-delete
 *
 * IRREVERSIBLE. Deletes the user from Clerk AND purges every Convex row
 * referencing that userId. Superadmin-only. Requires double-confirmation:
 *   { confirmEmail: <target email>, confirmPhrase: "DELETE" }
 *
 * Audit-first ordering (per advisor): we record the audit row BEFORE the
 * Clerk delete call. If Clerk succeeds, the success entry stands. If
 * Clerk errors, we record a SECOND entry with outcome="error". Either
 * way, evidence persists.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
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
  if (targetUserId === guard.userId) {
    return jsonError(
      { error: "You cannot hard-delete your own account.", code: "BAD_REQUEST" },
      400,
    );
  }

  let body: HardDeleteRequest;
  try {
    body = (await request.json()) as HardDeleteRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  if (body.confirmPhrase !== "DELETE") {
    return jsonError(
      { error: 'confirmPhrase must equal "DELETE".', code: "BAD_REQUEST" },
      400,
    );
  }

  const client = await clerkClient();
  let target;
  try {
    target = await client.users.getUser(targetUserId);
  } catch {
    return jsonError({ error: "User not found", code: "BAD_REQUEST" }, 404);
  }

  const targetEmail = target.primaryEmailAddress?.emailAddress ?? "";
  if (!targetEmail || body.confirmEmail.trim().toLowerCase() !== targetEmail.toLowerCase()) {
    return jsonError(
      {
        error:
          "confirmEmail must match the target user's primary email exactly.",
        code: "BAD_REQUEST",
      },
      400,
    );
  }

  // Last-superadmin protection.
  const currentRole = getRoleFromPublicMetadata(target.publicMetadata);
  if (currentRole === "superadmin") {
    const activeSupers = await countActiveSuperadmins();
    if (activeSupers <= 1) {
      return jsonError(
        {
          error:
            "Cannot delete the last active superadmin. Promote someone else first.",
          code: "BAD_REQUEST",
        },
        400,
      );
    }
  }

  const convex = getConvexClient();

  // 1. AUDIT FIRST — evidence must persist even if downstream calls fail.
  await recordAuditEvent({
    actor: { userId: guard.userId, role: "superadmin" },
    action: "USER_HARD_DELETED",
    targetUserId,
    metadata: {
      targetEmail,
      previousRole: currentRole,
      stage: "starting",
    },
    convex,
    mutationRef: api.admin.appendAuditEvent,
  });

  let purged: { counts: Record<string, number> } | null = null;
  try {
    // 2. Purge Convex rows.
    purged = (await convex.mutation(api.admin.purgeAllUserData, {
      adminSecret: getAdminConvexSecret(),
      targetUserId,
    })) as { counts: Record<string, number> };

    // 3. Delete Clerk user.
    await client.users.deleteUser(targetUserId);

    // 4. Final success audit (with the purge counts attached).
    await recordAuditEvent({
      actor: { userId: guard.userId, role: "superadmin" },
      action: "USER_HARD_DELETED",
      targetUserId,
      metadata: {
        targetEmail,
        previousRole: currentRole,
        stage: "complete",
        purged: purged.counts,
      },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true, purged: purged.counts });
  } catch (err) {
    // Failure audit. The "starting" entry above already proves the attempt.
    await recordAuditEvent({
      actor: { userId: guard.userId, role: "superadmin" },
      action: "USER_HARD_DELETED",
      targetUserId,
      metadata: {
        targetEmail,
        stage: "failed",
        partialPurge: purged?.counts ?? null,
      },
      outcome: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
