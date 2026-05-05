/**
 * POST /api/wiki/sync
 *
 * Thin HTTP wrapper around the shared syncUserWiki() server function.
 * The actual logic lives in apps/web/lib/server/wiki-sync.ts so reminders
 * routes can call it directly without an HTTP roundtrip.
 */

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { syncUserWiki } from "../../../../lib/server/wiki-sync";

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await syncUserWiki(userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[wiki/sync] error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
