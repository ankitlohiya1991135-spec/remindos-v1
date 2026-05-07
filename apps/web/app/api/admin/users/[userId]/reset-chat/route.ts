import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import type { AdminApiError } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/[userId]/reset-chat
 *
 * Wipe all of a user's `chatMessages` rows. Available to admin AND
 * superadmin. Useful for support after a user requests a chat reset.
 *
 * Self-protection: cannot reset your own chat through this endpoint —
 * the user can use the in-app "Clear Chat History" drawer button.
 */
export async function POST(
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

  const { userId: targetUserId } = await context.params;
  if (!targetUserId) {
    return jsonError({ error: "userId is required", code: "BAD_REQUEST" }, 400);
  }
  if (targetUserId === guard.userId) {
    return jsonError(
      {
        error:
          "Use the in-app drawer to clear your own chat history. This endpoint is for moderating other users.",
        code: "BAD_REQUEST",
      },
      400,
    );
  }

  try {
    const convex = getConvexClient();
    const result = (await convex.mutation(api.admin.resetUserChatHistory, {
      adminSecret: getAdminConvexSecret(),
      targetUserId,
    })) as { deleted: number };

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "CHAT_HISTORY_RESET",
      targetUserId,
      metadata: { deleted: result.deleted },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
