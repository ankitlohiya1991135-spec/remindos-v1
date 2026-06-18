import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import { canAccessAdmin, getRoleFromPublicMetadata } from "@repo/admin";
import type {
  AdminApiError,
  BroadcastListItem,
  SendBroadcastRequest,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";

const MAX_TITLE = 120;
const MAX_BODY = 1000;
const VALID_SEGMENTS = ["all", "active_today", "active_7d", "admins_only", "single_user"] as const;

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

interface RawBroadcastRow {
  id: string;
  senderUserId: string;
  senderRole: "admin";
  title: string;
  body: string;
  segment: BroadcastListItem["segment"];
  recipientCount: number;
  recalledAt: number | null;
  recalledBy: string | null;
  createdAt: number;
}

/**
 * GET /api/admin/broadcasts
 *
 * Lists past broadcasts. Display names for sender / recaller are resolved
 * via Clerk for nicer UI.
 */
export async function GET() {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  try {
    const convex = getConvexClient();
    const rows = (await convex.query(api.admin.listBroadcasts, {
      adminSecret: getAdminConvexSecret(),
    })) as RawBroadcastRow[];

    const idsToResolve = new Set<string>();
    for (const r of rows) {
      idsToResolve.add(r.senderUserId);
      if (r.recalledBy) idsToResolve.add(r.recalledBy);
    }
    const displayMap = new Map<string, string>();
    if (idsToResolve.size > 0) {
      const client = await clerkClient();
      const res = await client.users.getUserList({
        userId: [...idsToResolve],
        limit: 200,
      });
      for (const u of res.data) {
        const display =
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.primaryEmailAddress?.emailAddress ||
          u.id;
        displayMap.set(u.id, display);
      }
    }

    const enriched: BroadcastListItem[] = rows.map((r) => ({
      id: r.id,
      senderUserId: r.senderUserId,
      senderDisplay: displayMap.get(r.senderUserId) ?? r.senderUserId,
      senderRole: r.senderRole,
      title: r.title,
      body: r.body,
      segment: r.segment,
      recipientCount: r.recipientCount,
      recalledAt: r.recalledAt,
      recalledBy: r.recalledBy,
      recalledByDisplay: r.recalledBy
        ? displayMap.get(r.recalledBy) ?? r.recalledBy
        : null,
      createdAt: r.createdAt,
    }));

    return NextResponse.json({ broadcasts: enriched });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}

/**
 * POST /api/admin/broadcasts
 *
 * Send a broadcast. Available to all admins. Body:
 *   { title, body, segment: "all" | "active_today" | "active_7d" | "admins_only" }
 */
export async function POST(request: Request) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  let body: SendBroadcastRequest;
  try {
    body = (await request.json()) as SendBroadcastRequest;
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
  if (!(VALID_SEGMENTS as readonly string[]).includes(body.segment)) {
    return jsonError(
      { error: `segment must be one of: ${VALID_SEGMENTS.join(", ")}`, code: "BAD_REQUEST" },
      400,
    );
  }

  // Single-user targeting: the recipient is supplied directly, not resolved
  // from a segment. Validate the userId exists in Clerk before sending.
  if (body.segment === "single_user") {
    const recipientUserId = (body.recipientUserId ?? "").trim();
    if (!recipientUserId) {
      return jsonError({ error: "recipientUserId is required for single_user", code: "BAD_REQUEST" }, 400);
    }
    try {
      const client = await clerkClient();
      await client.users.getUser(recipientUserId);
    } catch {
      return jsonError({ error: "Recipient user not found", code: "BAD_REQUEST" }, 404);
    }
  }

  try {
    // 1. Resolve recipients: a single explicit user, or a segment via Clerk + activity.
    const recipientIds =
      body.segment === "single_user"
        ? [(body.recipientUserId ?? "").trim()]
        : await resolveRecipients(body.segment);

    if (recipientIds.length === 0) {
      return jsonError(
        { error: "Segment matched zero users — broadcast not sent.", code: "BAD_REQUEST" },
        400,
      );
    }

    // 2. Send broadcast (Convex inserts notifications + broadcast row).
    const convex = getConvexClient();
    const broadcastId = (await convex.mutation(api.admin.sendBroadcast, {
      adminSecret: getAdminConvexSecret(),
      senderUserId: guard.userId,
      senderRole: guard.role,
      title,
      body: messageBody,
      segment: body.segment,
      recipientUserIds: recipientIds,
    })) as string;

    // 3. Audit.
    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "BROADCAST_SENT",
      metadata: {
        broadcastId,
        segment: body.segment,
        recipientCount: recipientIds.length,
        title,
      },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({
      ok: true,
      broadcastId,
      recipientCount: recipientIds.length,
    });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}

/**
 * Resolve which userIds match a broadcast segment.
 *
 * For segments based on activity ("active_today", "active_7d") we ask
 * Convex for the per-user activity stats (already used by the user list).
 */
async function resolveRecipients(
  segment: BroadcastListItem["segment"],
): Promise<string[]> {
  const client = await clerkClient();
  // Page through Clerk users (cap 5000 same as elsewhere).
  const PAGE = 200;
  const HARD_CAP = 5000;
  const allUsers: { id: string; role: ReturnType<typeof getRoleFromPublicMetadata>; banned: boolean }[] = [];
  let offset = 0;
  while (offset < HARD_CAP) {
    const res = await client.users.getUserList({ limit: PAGE, offset });
    for (const u of res.data) {
      allUsers.push({
        id: u.id,
        role: getRoleFromPublicMetadata(u.publicMetadata),
        banned: Boolean((u as { banned?: boolean }).banned),
      });
    }
    if (res.data.length < PAGE) break;
    offset += PAGE;
  }

  // Drop banned users — they shouldn't get notifications.
  const eligible = allUsers.filter((u) => !u.banned);

  if (segment === "admins_only") {
    return eligible.filter((u) => canAccessAdmin(u.role)).map((u) => u.id);
  }
  if (segment === "all") {
    return eligible.map((u) => u.id);
  }

  // Active segments — ask Convex for activity for ALL eligible ids.
  const convex = getConvexClient();
  const activityMap = (await convex.query(api.admin.activityForUsers, {
    userIds: eligible.map((u) => u.id),
    adminSecret: getAdminConvexSecret(),
  })) as Record<string, { activeToday: boolean; promptsLast7d: number }>;

  return eligible
    .filter((u) => {
      const a = activityMap[u.id];
      if (!a) return false;
      if (segment === "active_today") return a.activeToday;
      if (segment === "active_7d") return a.promptsLast7d > 0;
      return false;
    })
    .map((u) => u.id);
}
