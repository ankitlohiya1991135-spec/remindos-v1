/**
 * POST /api/track/notification-click
 *
 * Called by the service worker when a user clicks a push notification.
 * Records the click against the most recent matching notification so the admin
 * dashboard can show click-through-rate (CTR) per user. Best-effort: failures
 * are silent (tracking must never break the click-through itself).
 */
import { auth } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../../lib/server/convex-client";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });

  let body: { type?: string; reminderId?: string | null } = {};
  try {
    body = (await request.json()) as { type?: string; reminderId?: string | null };
  } catch {
    /* ignore malformed body */
  }

  const type = typeof body.type === "string" ? body.type : null;
  if (!type) return NextResponse.json({ ok: false, error: "type required" }, { status: 400 });

  try {
    const client = getConvexClient();
    const attributed = await client.mutation(api.notifications.markClickedByType, {
      userId,
      type,
      ...(body.reminderId ? { reminderId: String(body.reminderId) } : {}),
    });
    return NextResponse.json({ ok: true, attributed });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
