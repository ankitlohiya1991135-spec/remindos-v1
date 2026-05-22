import { auth, currentUser } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../../lib/server/convex-client";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    preDueMinutes?: number;
    smartNudgeEnabled?: boolean;
    timeZone?: string;
  };
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const authSecret = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !authSecret) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }
  const preDueMinutes =
    typeof body.preDueMinutes === "number" && Number.isFinite(body.preDueMinutes)
      ? Math.max(0, Math.round(body.preDueMinutes))
      : undefined;
  const smartNudgeEnabled =
    typeof body.smartNudgeEnabled === "boolean" ? body.smartNudgeEnabled : undefined;
  const timeZone =
    typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : undefined;

  // Capture first name for personalised nudge copy (best-effort).
  let displayName: string | undefined;
  try {
    const user = await currentUser();
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
    displayName = name || user?.username || undefined;
  } catch { /* non-critical */ }

  try {
    const client = getConvexClient();
    await client.mutation(api.pushSubscriptions.savePushSubscription, {
      userId,
      endpoint,
      p256dh,
      auth: authSecret,
      ...(preDueMinutes !== undefined ? { preDueMinutes } : {}),
      ...(smartNudgeEnabled !== undefined ? { smartNudgeEnabled } : {}),
      ...(timeZone !== undefined ? { timeZone } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
