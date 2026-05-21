import { auth, currentUser } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { formatNameWithInitial } from "../../../../../lib/actor-display";
import { appendSystemChatMessage } from "../../../../../lib/server/chat-notify";
import { getConvexClient } from "../../../../../lib/server/convex-client";
import { sendWebPushToUser } from "../../../../../lib/server/send-web-push";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  if (!token?.trim()) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  let preview;
  try {
    const client = getConvexClient();
    preview = await client.query(api.reminderSharing.getInviteByToken, {
      token: decodeURIComponent(token),
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
  if (!preview) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  return NextResponse.json({ preview });
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { token } = await context.params;
  if (!token?.trim()) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const user = await currentUser();
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim()
    || user?.username
    || user?.primaryEmailAddress?.emailAddress
    || "Someone";
  const displayWithInitial = formatNameWithInitial(user);

  let result: {
    ok: boolean;
    reason?: string;
    title?: string;
    ownerUserId?: string;
    displayName?: string;
    already?: boolean;
    reminderId?: unknown;
  };
  try {
    const client = getConvexClient();
    result = await client.mutation(api.reminderSharing.acceptInvite, {
      token: decodeURIComponent(token),
      userId,
      displayName,
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }

  if (!result.ok) {
    if (result.reason === "owner_self") {
      return NextResponse.json(
        { error: "You cannot accept your own reminder invite.", title: result.title },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  const title = result.title as string;
  const ownerUserId = result.ownerUserId as string;
  const name = result.displayName as string;

  if (!result.already) {
    await appendSystemChatMessage(
      ownerUserId,
      `Your reminder "${title}" was accepted by ${displayWithInitial}.`
    );
    await appendSystemChatMessage(
      userId,
      `${displayWithInitial} — you joined "${title}" (shared by the owner). Manage it under Reminders.`
    );
    // Push to owner so they know on their phone too
    void sendWebPushToUser(ownerUserId, {
      type: "share_accepted",
      title: "Reminder share accepted",
      body: `${displayWithInitial} accepted your reminder "${title}".`,
      tag: `share-ack-token-${token}`,
      accepterName: displayWithInitial,
      count: 1,
    });
  }

  try {
    const client = getConvexClient();
    if (result.reminderId) {
      await client.mutation(api.reminderSharing.dismissShareInboxForReminder, {
        userId,
        reminderId: result.reminderId as any,
      });
    }
  } catch {
    /* inbox cleanup is best-effort */
  }

  return NextResponse.json({
    ok: true,
    already: result.already,
    reminderId: result.reminderId,
    title,
    ownerUserId,
    displayName: name,
  });
}
