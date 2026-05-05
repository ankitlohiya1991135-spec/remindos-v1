import { auth, currentUser } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { formatNameWithInitial } from "../../../../lib/actor-display";
import { appendSystemChatMessage } from "../../../../lib/server/chat-notify";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { syncUserWiki } from "../../../../lib/server/wiki-sync";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function parseReminderId(id: string) {
  // Convex validates the id format at runtime.
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
    dueAt?: number;
    status?: "pending" | "done" | "archived";
    recurrence?: "none" | "daily" | "weekly" | "monthly";
    priority?: number;
    urgency?: number;
    tags?: string[];
    linkedTaskId?: string | null;
    domain?: "health" | "finance" | "career" | "hobby" | "fun" | null;
  };

  const needsStarPriority =
    body.title !== undefined
    || body.notes !== undefined
    || body.recurrence !== undefined;
  if (
    needsStarPriority
    && (body.priority == null
      || !Number.isFinite(Number(body.priority))
      || Number(body.priority) < 1
      || Number(body.priority) > 5)
  ) {
    return NextResponse.json(
      { error: "priority (1–5 stars) is required when updating title, notes, or recurrence" },
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

  let reminder: unknown;
  try {
    const client = getConvexClient();
    const patch: Record<string, unknown> = { ...body };
    if (body.linkedTaskId === "") {
      patch.linkedTaskId = null;
    }
    reminder = await client.mutation(api.reminders.update, {
      userId,
      reminderId: parseReminderId(id),
      ...patch,
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }

  if (reminder && typeof reminder === "object" && "userId" in reminder) {
    const ownerId = (reminder as { userId: string }).userId;
    const reminderTitle = String((reminder as { title?: string }).title ?? "Reminder");
    const reminderDomain = (reminder as { domain?: string }).domain as
      | "health" | "finance" | "career" | "hobby" | "fun" | undefined;

    if (ownerId && ownerId !== userId) {
      const user = await currentUser();
      const actor = formatNameWithInitial(user);
      let line = `${actor} updated "${reminderTitle}".`;
      if (body.status === "done") line = `${actor} marked "${reminderTitle}" as done.`;
      else if (body.status === "pending") line = `${actor} put "${reminderTitle}" back to pending.`;
      else if (body.status === "archived") line = `${actor} archived "${reminderTitle}".`;
      else if (body.dueAt != null) line = `${actor} rescheduled "${reminderTitle}".`;
      else if (body.title != null) line = `${actor} edited the reminder (now "${reminderTitle}").`;
      await appendSystemChatMessage(ownerId, line);
    }

    // MISSING-3: track completion event (fire-and-forget)
    if (body.status === "done") {
      const client = getConvexClient();
      client.mutation(api.userEvents.track, {
        userId,
        eventType: "reminder_completed",
        entityId: id,
        entityTitle: reminderTitle,
        ...(reminderDomain ? { domain: reminderDomain } : {}),
      }).catch(() => {});

      // Wiki ingest: rebuild wiki after mark-done (fire-and-forget, direct call)
      syncUserWiki(userId).catch(() => {});
    } else if (body.title !== undefined || body.notes !== undefined) {
      // Wiki ingest: rebuild wiki when reminder title/notes change (affects domain pages)
      syncUserWiki(userId).catch(() => {});
    }
  }

  return NextResponse.json({ reminder });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  let result:
    | { ok: false }
    | { ok: true; title: string; ownerUserId: string; actorWasOwner: boolean };
  try {
    const client = getConvexClient();
    result = (await client.mutation(api.reminders.remove, {
      userId,
      reminderId: parseReminderId(id),
    })) as typeof result;
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  if (!result.actorWasOwner) {
    const user = await currentUser();
    const actor = formatNameWithInitial(user);
    await appendSystemChatMessage(result.ownerUserId, `${actor} deleted "${result.title}".`);
  }

  // MISSING-3: track deletion event (fire-and-forget)
  {
    const client = getConvexClient();
    client.mutation(api.userEvents.track, {
      userId,
      eventType: "reminder_deleted",
      entityId: id,
      entityTitle: result.title,
    }).catch(() => {});

    // Wiki ingest: rebuild wiki after deletion (fire-and-forget, direct call)
    syncUserWiki(userId).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
