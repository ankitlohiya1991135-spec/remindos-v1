import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import type {
  AdminApiError,
  UpdateAdminNoteRequest,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../lib/server/convex-client";

const MAX_NOTE_CONTENT = 2000;

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * PATCH /api/admin/notes/[noteId] — edit a note.
 *
 * Any admin can edit any note.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ noteId: string }> },
) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const { noteId } = await context.params;
  if (!noteId) {
    return jsonError({ error: "noteId is required", code: "BAD_REQUEST" }, 400);
  }

  let body: UpdateAdminNoteRequest;
  try {
    body = (await request.json()) as UpdateAdminNoteRequest;
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
    const result = (await convex.mutation(api.admin.updateUserAdminNote, {
      adminSecret: getAdminConvexSecret(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      noteId: noteId as any,
      callerUserId: guard.userId,
      content,
    })) as { ok: boolean; originalAuthor: string };

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "ADMIN_NOTE_EDITED",
      metadata: {
        noteId,
        originalAuthor: result.originalAuthor,
      },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Convex `Forbidden` from the mutation → 403.
    if (msg.toLowerCase().includes("forbidden")) {
      return jsonError(
        { error: "You can only edit notes you wrote.", code: "FORBIDDEN" },
        403,
      );
    }
    return jsonError({ error: msg, code: "INTERNAL" }, 500);
  }
}

/**
 * DELETE /api/admin/notes/[noteId]
 *
 * Any admin can delete any note.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ noteId: string }> },
) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const { noteId } = await context.params;
  if (!noteId) {
    return jsonError({ error: "noteId is required", code: "BAD_REQUEST" }, 400);
  }

  try {
    const convex = getConvexClient();
    const result = (await convex.mutation(api.admin.deleteUserAdminNote, {
      adminSecret: getAdminConvexSecret(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      noteId: noteId as any,
      callerUserId: guard.userId,
    })) as { ok: boolean; originalAuthor: string };

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "ADMIN_NOTE_DELETED",
      metadata: {
        noteId,
        originalAuthor: result.originalAuthor,
      },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("forbidden")) {
      return jsonError(
        { error: "You can only delete notes you wrote.", code: "FORBIDDEN" },
        403,
      );
    }
    return jsonError({ error: msg, code: "INTERNAL" }, 500);
  }
}
