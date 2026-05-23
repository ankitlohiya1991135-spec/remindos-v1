import { auth } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { syncUserWiki } from "../../../../lib/server/wiki-sync";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function parseTaskId(id: string) {
  return id as any;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const body = (await request.json()) as {
    title?: string;
    notes?: string;
    dueAt?: number | null;
    status?: "pending" | "done";
    priority?: number;
    domain?: "health" | "finance" | "career" | "hobby" | "fun" | null;
  };

  const needsStarPriority = body.title !== undefined || body.notes !== undefined;
  if (
    needsStarPriority
    && (body.priority == null
      || !Number.isFinite(Number(body.priority))
      || Number(body.priority) < 1
      || Number(body.priority) > 5)
  ) {
    return NextResponse.json(
      { error: "priority (1–5 stars) is required when updating title or notes" },
      { status: 400 }
    );
  }

  if (body.dueAt != null) {
    const dueAt = Number(body.dueAt);
    if (!Number.isFinite(dueAt)) {
      return NextResponse.json({ error: "dueAt must be a valid timestamp" }, { status: 400 });
    }
    if (dueAt <= Date.now()) {
      return NextResponse.json({ error: "dueAt must be in the future" }, { status: 400 });
    }
  }

  const patch: {
    userId: string;
    taskId: ReturnType<typeof parseTaskId>;
    title?: string;
    notes?: string;
    dueAt?: number;
    status?: "pending" | "done";
    priority?: number;
    domain?: "health" | "finance" | "career" | "hobby" | "fun" | null;
  } = { userId, taskId: parseTaskId(id) };
  if (body.title !== undefined) patch.title = body.title;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.status !== undefined) patch.status = body.status;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.domain !== undefined) patch.domain = body.domain;
  if (body.dueAt === null) {
    /* keep dueAt unset — Convex optional clear not implemented */
  } else if (body.dueAt != null && Number.isFinite(Number(body.dueAt))) {
    patch.dueAt = Number(body.dueAt);
  }

  try {
    const client = getConvexClient();
    const task = await client.mutation(api.tasks.update, patch);
    if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // MISSING-3: track task completion event (fire-and-forget)
    if (body.status === "done") {
      const t = task as Record<string, unknown>;
      const taskDomain = t.domain as "health" | "finance" | "career" | "hobby" | "fun" | undefined;
      client.mutation(api.userEvents.track, {
        userId,
        eventType: "task_completed",
        entityId: id,
        entityTitle: String(t.title ?? ""),
        ...(taskDomain ? { domain: taskDomain } : {}),
      }).catch(() => {});
      // Wiki ingest: rebuild wiki after task completion (fire-and-forget)
      syncUserWiki(userId).catch(() => {});
    } else if (body.title !== undefined || body.notes !== undefined) {
      // Wiki ingest: rebuild wiki when task title/notes change
      syncUserWiki(userId).catch(() => {});
    }
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  try {
    const client = getConvexClient();
    const result = await client.mutation(api.tasks.remove, {
      userId,
      taskId: parseTaskId(id),
    });
    if (!result.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Wiki ingest: rebuild wiki after task deletion (fire-and-forget)
    syncUserWiki(userId).catch(() => {});
    return NextResponse.json({
      ok: true,
      unlinkedReminderCount:
        typeof result.unlinkedReminderCount === "number" ? result.unlinkedReminderCount : 0,
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
