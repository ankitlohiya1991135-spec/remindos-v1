import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import type { AdminApiError } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * DELETE /api/admin/broadcasts/[id]
 *
 * Recall a broadcast. Authorization tier (the explicit override pattern):
 *   - Admin: may recall ONLY broadcasts they themselves sent.
 *   - Superadmin: may recall ANY broadcast (including those sent by an
 *     admin or another superadmin) — the override capability.
 *
 * Recall is idempotent — calling twice returns success without re-sending.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const { id } = await context.params;
  if (!id) {
    return jsonError({ error: "broadcast id is required", code: "BAD_REQUEST" }, 400);
  }

  try {
    const convex = getConvexClient();

    // Fetch the broadcast first to check ownership for non-superadmin.
    const broadcasts = (await convex.query(api.admin.listBroadcasts, {
      adminSecret: getAdminConvexSecret(),
      limit: 500,
    })) as Array<{ id: string; senderUserId: string; recalledAt: number | null }>;

    const target = broadcasts.find((b) => b.id === id);
    if (!target) {
      return jsonError({ error: "Broadcast not found", code: "BAD_REQUEST" }, 404);
    }

    // Override check: admins can only recall their own.
    if (guard.role === "admin" && target.senderUserId !== guard.userId) {
      return jsonError(
        {
          error:
            "Admins can only recall their own broadcasts. Superadmin override required.",
          code: "FORBIDDEN",
        },
        403,
      );
    }

    await convex.mutation(api.admin.recallBroadcast, {
      adminSecret: getAdminConvexSecret(),
      // Convex `Id<"adminBroadcasts">` is a branded string at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      broadcastId: id as any,
      recallerUserId: guard.userId,
    });

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "BROADCAST_RECALLED",
      metadata: {
        broadcastId: id,
        originalSender: target.senderUserId,
        wasOverride:
          guard.role === "superadmin" && target.senderUserId !== guard.userId,
      },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
