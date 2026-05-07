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
  authorRole: "admin" | "superadmin";
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * GET /api/admin/users/[userId]/notes
 *
 * List notes about a user. Admin AND superadmin can read. The
 * `authorRole` field is masked: admin viewers always see "admin" even
 * when the note was authored by a superadmin (privacy hierarchy).
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

    const callerIsSuperadmin = guard.role === "superadmin";

    const notes: AdminNote[] = rows.map((r) => {
      // Edit permission: own note OR superadmin (override).
      const isOwn = r.authorUserId === guard.userId;
      const canEdit = isOwn || callerIsSuperadmin;

      // PRIVACY: For admin viewers, anonymize ALL authors (including
      // their own) to "Staff". Showing real names would let an admin
      // deduce that a user masked as "user" is actually privileged
      // when they see that same person authoring notes. Uniform
      // anonymization closes the inference channel; `canEdit` is the
      // signal the UI uses to show edit buttons, so admins don't lose
      // the ability to edit their own notes.
      const authorDisplay = callerIsSuperadmin
        ? displayMap.get(r.authorUserId) ?? r.authorUserId
        : isOwn
          ? "You"
          : "Staff";

      return {
        id: r.id,
        targetUserId: r.targetUserId,
        // Hide raw userId from non-superadmin viewers too — the userId
        // alone is enough to look someone up and learn their identity.
        authorUserId: callerIsSuperadmin ? r.authorUserId : "",
        authorDisplay,
        // PRIVACY: mask author role for admin viewers.
        authorRole: callerIsSuperadmin ? r.authorRole : "admin",
        content: r.content,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        canEdit,
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
 * Create a new admin note. Available to admin AND superadmin.
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
