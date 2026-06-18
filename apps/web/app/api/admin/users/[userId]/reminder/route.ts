import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
  recordAuditEvent,
} from "@repo/admin/server";
import type { AdminApiError, CreateUserReminderRequest } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../../lib/server/convex-client";
import { sendWebPushToUser } from "../../../../../../lib/server/send-web-push";

const MAX_TITLE = 200;
const VALID_DOMAINS = ["health", "finance", "career", "hobby", "fun"] as const;
const VALID_RECURRENCE = ["none", "daily", "weekly", "monthly"] as const;

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/[userId]/reminder
 *
 * Admin creates a reminder ON BEHALF OF a user. The user is told about it three
 * ways so they never miss it: (1) the reminder lands in their list, (2) a warm
 * assistant message is dropped into their chat (visible next time they open the
 * app — covers the case where their own attempt to create it failed earlier),
 * and (3) a push notification + notification-feed entry.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const { userId: targetUserId } = await context.params;
  if (!targetUserId) {
    return jsonError({ error: "userId is required", code: "BAD_REQUEST" }, 400);
  }

  let body: CreateUserReminderRequest;
  try {
    body = (await request.json()) as CreateUserReminderRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  const title = (body.title ?? "").trim();
  if (!title) return jsonError({ error: "title is required", code: "BAD_REQUEST" }, 400);
  if (title.length > MAX_TITLE) {
    return jsonError({ error: `title exceeds ${MAX_TITLE} chars`, code: "BAD_REQUEST" }, 400);
  }
  const dueAt = Number(body.dueAt);
  if (!Number.isFinite(dueAt) || dueAt <= 0) {
    return jsonError({ error: "dueAt (epoch ms) is required", code: "BAD_REQUEST" }, 400);
  }

  const domain = VALID_DOMAINS.includes(body.domain as (typeof VALID_DOMAINS)[number])
    ? (body.domain as (typeof VALID_DOMAINS)[number])
    : undefined;
  const recurrence = VALID_RECURRENCE.includes(body.recurrence as (typeof VALID_RECURRENCE)[number])
    ? (body.recurrence as (typeof VALID_RECURRENCE)[number])
    : "none";
  const priority = typeof body.priority === "number" ? body.priority : undefined;
  const notes = body.notes?.trim() || undefined;

  try {
    // Confirm the target user exists in Clerk before writing anything.
    const clerk = await clerkClient();
    try {
      await clerk.users.getUser(targetUserId);
    } catch {
      return jsonError({ error: "User not found", code: "BAD_REQUEST" }, 404);
    }

    const convex = getConvexClient();

    // 1. Create the reminder in the user's own list.
    const result = (await convex.mutation(api.reminders.create, {
      userId: targetUserId,
      title,
      dueAt,
      notes,
      priority,
      domain,
      recurrence,
    })) as { created: boolean; reminder: { _id: string } | null };

    const reminderId = result.reminder?._id;
    const whenLabel = new Date(dueAt).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });

    // 2. Drop a warm assistant message into the user's chat so they see it next
    //    time they open the app — phrased to cover "couldn't add it before, it's set now".
    const chatContent =
      `✅ I've set up a reminder for you: **"${title}"** — ${whenLabel}` +
      (recurrence !== "none" ? ` (repeats ${recurrence})` : "") +
      `. It's on your list now — adjust or remove it anytime.`;
    await convex.mutation(api.chat.insertMessage, {
      userId: targetUserId,
      clientId: `admin-reminder-${reminderId ?? Date.now()}`,
      role: "assistant",
      content: chatContent,
      createdAt: Date.now(),
    });

    // 3. Notification feed entry + push.
    const pushTitle = "Reminder added for you 🌱";
    const pushBody = `"${title}" — ${whenLabel}`;
    await convex.mutation(api.notifications.create, {
      userId: targetUserId,
      type: "admin_reminder",
      title: pushTitle,
      body: pushBody,
      ...(reminderId ? { reminderId } : {}),
    });
    let pushed = 0;
    try {
      pushed = await sendWebPushToUser(targetUserId, {
        type: "admin_reminder",
        title: pushTitle,
        body: pushBody,
        reminderId,
      });
    } catch {
      /* push failure must not fail the whole request — the chat msg + feed still land */
    }

    await recordAuditEvent({
      actor: { userId: guard.userId, role: guard.role },
      action: "USER_REMINDER_CREATED",
      targetUserId,
      metadata: { title, dueAt, recurrence, reminderId: reminderId ?? null, pushed },
      convex,
      mutationRef: api.admin.appendAuditEvent,
    });

    return NextResponse.json({ ok: true, created: result.created, reminderId, pushed });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
