import { auth } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../lib/server/convex-client";
import { syncUserWiki } from "../../../lib/server/wiki-sync";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const client = getConvexClient();
    const tasks = await client.query(api.tasks.listForUser, { userId });
    return NextResponse.json({ tasks });
  } catch {
    return NextResponse.json({ tasks: [] });
  }
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    title?: string;
    notes?: string;
    dueAt?: number | null;
    status?: "pending" | "done";
    priority?: number;
    domain?: "health" | "finance" | "career" | "hobby" | "fun";
  };
  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }

  const dueAt =
    body.dueAt != null && Number.isFinite(Number(body.dueAt)) ? Number(body.dueAt) : undefined;
  if (dueAt != null && dueAt <= Date.now()) {
    return NextResponse.json({ error: "dueAt must be in the future" }, { status: 400 });
  }

  const rawPri = (body as { priority?: number }).priority;
  const priority =
    rawPri != null && Number.isFinite(Number(rawPri)) && Number(rawPri) >= 1 && Number(rawPri) <= 5
      ? Math.round(Number(rawPri))
      : 3;

  try {
    const client = getConvexClient();
    const task = await client.mutation(api.tasks.create, {
      userId,
      title: body.title.trim(),
      notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : undefined,
      dueAt,
      status: body.status ?? "pending",
      priority,
      ...(body.domain ? { domain: body.domain } : {}),
    });
    // MISSING-3: track task creation event (fire-and-forget)
    client.mutation(api.userEvents.track, {
      userId,
      eventType: "task_created",
      entityId: String((task as any)?._id ?? ""),
      entityTitle: body.title.trim(),
      ...(body.domain ? { domain: body.domain } : {}),
    }).catch(() => {});
    // Wiki ingest: rebuild wiki after task creation (fire-and-forget)
    syncUserWiki(userId).catch(() => {});
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
