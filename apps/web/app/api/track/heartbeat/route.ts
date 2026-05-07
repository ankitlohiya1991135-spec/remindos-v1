import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";

/**
 * POST /api/track/heartbeat
 *
 * Privacy-preserving usage ping. The client posts here every ~60s while
 * the tab is visible. Stores only timing — no content, no actions, no
 * page paths. Used by admin tooling to surface "how much" a user uses
 * the app without surfacing "what" they do.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = getConvexClient();
    const result = await client.mutation(api.userSessions.heartbeat, { userId });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
