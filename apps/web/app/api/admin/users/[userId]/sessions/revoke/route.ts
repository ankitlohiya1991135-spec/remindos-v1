import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  recordAuditEvent,
} from "@repo/admin/server";
import type { AdminApiError } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/[userId]/sessions/revoke
 *
 * Admin-only. Force-signs-out a user from every device by revoking
 * all their active Clerk sessions. They'll have to sign in again to use
 * the app. Does not affect their account beyond that.
 *
 * Cannot revoke your own sessions — that would lock you out mid-action.
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
      { error: "Cannot revoke your own sessions.", code: "BAD_REQUEST" },
      400,
    );
  }

  try {
    const client = await clerkClient();
    const sessions = await client.sessions.getSessionList({
      userId: targetUserId,
      status: "active",
    });

    let revoked = 0;
    for (const s of sessions.data) {
      try {
        await client.sessions.revokeSession(s.id);
        revoked++;
      } catch {
        // Continue revoking the rest even if one fails.
      }
    }

    await recordAuditEvent({
      actor: { userId: guard.userId, role: "admin" },
      action: "USER_SESSIONS_REVOKED",
      targetUserId,
      metadata: { revoked, totalActive: sessions.data.length },
      convex: getConvexClient(),
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true, revoked });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
