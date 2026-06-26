import { auth } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getAuthedConvexClient } from "../../../lib/server/convex-client";
import { syncUserWiki } from "../../../lib/server/wiki-sync";
import { sendWebPushToUser } from "../../../lib/server/send-web-push";

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const client = await getAuthedConvexClient();
    const data = (await client.query(api.reminders.listForUser, { userId })) as {
      owned: Array<Record<string, unknown>>;
      shared: Array<Record<string, unknown>>;
    };
    const shareMeta = (await client.query(api.reminderSharing.listShareRecipientsForOwned, {
      userId,
    })) as {
      reminderId: string;
      recipients: { userId: string; displayName: string }[];
    }[];
    const recipientsByReminder = new Map<string, { userId: string; displayName: string }[]>();
    for (const row of shareMeta) {
      recipientsByReminder.set(String(row.reminderId), row.recipients);
    }

    const merged: Array<Record<string, unknown>> = [
      ...data.owned.map((r: Record<string, unknown>) => {
        const rid = String(r._id ?? "");
        const recipients = recipientsByReminder.get(rid) ?? [];
        return {
          ...r,
          _access: "owner",
          _shareRecipients: recipients,
          _outgoingShared: recipients.length > 0,
        };
      }),
      ...data.shared.map((r: Record<string, unknown>) => ({ ...r, _access: "shared" })),
    ];
    merged.sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    return NextResponse.json({ reminders: merged });
  } catch {
    return NextResponse.json({ reminders: [] });
  }
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    title?: string;
    notes?: string;
    dueAt?: number;
    recurrence?: "none" | "daily" | "weekly" | "monthly";
    priority?: number;
    urgency?: number;
    tags?: string[];
    status?: "pending" | "done" | "archived";
    linkedTaskId?: string;
    domain?: "health" | "finance" | "career" | "hobby" | "fun";
  };
  if (!body.title?.trim() || body.dueAt == null) {
    return NextResponse.json({ error: "title and dueAt required" }, { status: 400 });
  }

  const dueAt = Number(body.dueAt);
  if (!Number.isFinite(dueAt)) {
    return NextResponse.json({ error: "dueAt must be a valid timestamp" }, { status: 400 });
  }
  // Allow up to 60 s in the past to absorb network latency between client-side
  // time parsing and server-side validation (matches isValidFutureIsoDate).
  if (dueAt < Date.now() - 60_000) {
    return NextResponse.json({ error: "dueAt must be in the future" }, { status: 400 });
  }

  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0 ? body.notes.trim() : undefined;

  const rawPri = body.priority;
  const priority =
    rawPri != null && Number.isFinite(Number(rawPri)) && Number(rawPri) >= 1 && Number(rawPri) <= 5
      ? Math.round(Number(rawPri))
      : 3;

  try {
    const client = await getAuthedConvexClient();
    const result = await client.mutation(api.reminders.create, {
      userId,
      title: body.title.trim(),
      notes,
      dueAt,
      recurrence: body.recurrence ?? "none",
      priority,
      urgency: body.urgency,
      tags: body.tags,
      status: body.status ?? "pending",
      ...(typeof body.linkedTaskId === "string" && body.linkedTaskId.trim()
        ? { linkedTaskId: body.linkedTaskId.trim() as any }
        : {}),
      ...(body.domain ? { domain: body.domain } : {}),
    });
    // MISSING-3: track creation event (fire-and-forget)
    if ((result as any)?.created) {
      const reminderId = String((result as any)?.reminder?._id ?? "");
      const reminderTitle = body.title.trim();

      client.mutation(api.userEvents.track, {
        userId,
        eventType: "reminder_created",
        entityId: reminderId,
        entityTitle: reminderTitle,
        ...(body.domain ? { domain: body.domain } : {}),
      }).catch(() => {});

      // Wiki ingest: rebuild wiki pages directly (no HTTP roundtrip)
      syncUserWiki(userId).catch(() => {});

      // ── Immediate push if reminder is due sooner than the pre-due window ──
      // The cron fires pre_due_reminder when dueAt ≈ now + preDueMs (±60 s).
      // If the reminder is created inside that window the cron tick may have
      // already passed — fire the warning immediately.
      // We always send pre_due_reminder here and let the cron send due_reminder
      // at actual due time, so the user reliably receives TWO distinct notifications
      // with different tags ("predue-X" vs "due-X") — Android treats them separately.
      void (async () => {
        try {
          const subs = await client.query(api.pushSubscriptions.listForUser, { userId });
          if (subs.length === 0) return;

          // Take the max preDueMinutes across the user's devices (same logic as cron).
          const DEFAULT_PRE = Number(process.env.PRE_DUE_MINUTES ?? "15");
          const userPreDue = subs.reduce(
            (max, s) => Math.max(max, s.preDueMinutes ?? DEFAULT_PRE),
            0,
          );
          const preDueMs = userPreDue * 60_000;
          const now = Date.now();
          const msUntilDue = dueAt - now;

          // Only fire when inside (or right at the edge of) the pre-due window.
          // If there is still plenty of time, the cron will handle the pre-due push.
          if (msUntilDue > preDueMs + 60_000) return;
          if (msUntilDue <= 0) return; // already overdue — skip

          // Always fire as pre_due_reminder so the cron can still fire due_reminder
          // at the actual due time using a different notification tag.
          const minsLeft = Math.max(1, Math.round(msUntilDue / 60_000));
          const pushBody = minsLeft <= 1
            ? "Due very soon — tap to open"
            : `Due in ${minsLeft} minute${minsLeft !== 1 ? "s" : ""}`;
          await sendWebPushToUser(userId, {
            type: "pre_due_reminder",
            reminderId,
            title: reminderTitle,
            body: pushBody,
            dueAt,
          });
          // Log it so the cron's alreadySent check skips the duplicate pre_due push.
          await client.mutation(api.pushNotificationLogs.logSent, {
            userId,
            type: "pre_due_reminder",
            reminderId,
            sentAt: Date.now(),
          });
        } catch {
          /* push is best-effort — never block the response */
        }
      })();
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
