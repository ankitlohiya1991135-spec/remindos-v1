import { auth } from "@clerk/nextjs/server";
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

  try {
    const client = getConvexClient();
    await client.mutation(api.pushSubscriptions.savePushSubscription, {
      userId,
      endpoint,
      p256dh,
      auth: authSecret,
      ...(preDueMinutes !== undefined ? { preDueMinutes } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
