import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import type {
  AdminApiError,
  SendDirectMessageRequest,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

const MAX_TITLE = 120;
const MAX_BODY = 1000;

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/[userId]/message
 *
 * Send a direct message to a single user. Available to all admins.
 * Inserts a notification into the user's notification feed.
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

  let body: SendDirectMessageRequest;
  try {
    body = (await request.json()) as SendDirectMessageRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  const title = (body.title ?? "").trim();
  const messageBody = (body.body ?? "").trim();
  if (!title || !messageBody) {
    return jsonError({ error: "title and body are required", code: "BAD_REQUEST" }, 400);
  }
  if (title.length > MAX_TITLE) {
    return jsonError({ error: `title exceeds ${MAX_TITLE} chars`, code: "BAD_REQUEST" }, 400);
  }
  if (messageBody.length > MAX_BODY) {
    return jsonError({ error: `body exceeds ${MAX_BODY} chars`, code: "BAD_REQUEST" }, 400);
  }

  try {
    // Confirm target exists in Clerk before writing.
    const client = await clerkClient();
    try {
      await client.users.getUser(targetUserId);
    } catch {
      return jsonError({ error: "User not found", code: "BAD_REQUEST" }, 404);
    }

    // Reuse the broadcast mutation with a single recipient — same shape.
    const convex = getConvexClient();
    await convex.mutation(api.admin.sendBroadcast, {
      adminSecret: getAdminConvexSecret(),
      senderUserId: guard.userId,
      senderRole: guard.role,
      title,
      body: messageBody,
      // No "single_user" segment exists; use admins_only as placeholder
      // marker. The recipientUserIds list is what actually targets — the
      // segment field is purely metadata in this context.
      segment: "admins_only",
      recipientUserIds: [targetUserId],
    });

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "USER_DM_SENT",
      targetUserId,
      metadata: { title, bodyLength: messageBody.length },
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
