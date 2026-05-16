import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import type {
  AdminApiError,
  AdminNote,
  CreateAdminNoteRequest,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";

const MAX_NOTE_CONTENT = 2000;

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

interface RawNote {
  id: string;
  targetUserId: string;
  authorUserId: string;
  authorRole: "admin";
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * GET /api/admin/users/[userId]/notes
 *
 * List notes about a user. Any admin can read all notes.
 */
export async function GET(
  _req: Request,
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

  try {
    const convex = getConvexClient();
    const rows = (await convex.query(api.admin.listUserAdminNotes, {
      adminSecret: getAdminConvexSecret(),
      targetUserId,
    })) as RawNote[];

    // Resolve author display names.
    const authorIds = new Set(rows.map((r) => r.authorUserId));
    const displayMap = new Map<string, string>();
    if (authorIds.size > 0) {
      const client = await clerkClient();
      const res = await client.users.getUserList({
        userId: [...authorIds],
        limit: 200,
      });
      for (const u of res.data) {
        displayMap.set(
          u.id,
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
            u.username ||
            u.primaryEmailAddress?.emailAddress ||
            u.id,
        );
      }
    }

    const notes: AdminNote[] = rows.map((r) => {
      const isOwn = r.authorUserId === guard.userId;
      const authorDisplay = displayMap.get(r.authorUserId) ?? (isOwn ? "You" : "Staff");

      return {
        id: r.id,
        targetUserId: r.targetUserId,
        authorUserId: r.authorUserId,
        authorDisplay,
        authorRole: r.authorRole,
        content: r.content,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        canEdit: true, // any admin can edit any note
      };
    });

    return NextResponse.json({ notes });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}

/**
 * POST /api/admin/users/[userId]/notes
 *
 * Create a new admin note. Available to all admins.
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

  let body: CreateAdminNoteRequest;
  try {
    body = (await request.json()) as CreateAdminNoteRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }
  const content = (body.content ?? "").trim();
  if (!content) {
    return jsonError({ error: "Note content is required", code: "BAD_REQUEST" }, 400);
  }
  if (content.length > MAX_NOTE_CONTENT) {
    return jsonError(
      { error: `Note exceeds ${MAX_NOTE_CONTENT} chars`, code: "BAD_REQUEST" },
      400,
    );
  }

  try {
    const convex = getConvexClient();
    const noteId = (await convex.mutation(api.admin.createUserAdminNote, {
      adminSecret: getAdminConvexSecret(),
      targetUserId,
      authorUserId: guard.userId,
      authorRole: guard.role,
      content,
    })) as string;

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "ADMIN_NOTE_CREATED",
      targetUserId,
      metadata: { noteId, contentLength: content.length },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true, noteId });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
