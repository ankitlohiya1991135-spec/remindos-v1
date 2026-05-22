import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const lifeDomain = v.union(
  v.literal("health"),
  v.literal("finance"),
  v.literal("career"),
  v.literal("hobby"),
  v.literal("fun")
);

function normalizeTitle(value: string) {
  return value.trim().toLowerCase();
}

async function getReminderAccess(
  ctx: QueryCtx | MutationCtx,
  reminderId: Id<"reminders">,
  userId: string
) {
  const reminder = await ctx.db.get(reminderId);
  if (!reminder) return null;
  if (reminder.userId === userId) return { reminder, role: "owner" as const };
  const participant = await ctx.db
    .query("reminderParticipants")
    .withIndex("by_reminder_user", (q) =>
      q.eq("reminderId", reminderId).eq("userId", userId)
    )
    .unique();
  if (participant) return { reminder, role: "participant" as const };
  return null;
}

async function deleteReminderCascade(ctx: MutationCtx, reminderId: Id<"reminders">) {
  const invites = await ctx.db
    .query("reminderInvites")
    .withIndex("by_reminder", (q) => q.eq("reminderId", reminderId))
    .collect();
  for (const inv of invites) {
    await ctx.db.delete(inv._id);
  }
  const participants = await ctx.db
    .query("reminderParticipants")
    .withIndex("by_reminder", (q) => q.eq("reminderId", reminderId))
    .collect();
  for (const p of participants) {
    await ctx.db.delete(p._id);
  }
  await ctx.db.delete(reminderId);
}

export const list = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reminders")
      .withIndex("by_user_dueAt", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

/**
 * Lightweight query used by the server-side push cron.
 * Returns reminders for a user filtered by status and a dueAt range.
 * Does NOT include shared/participant reminders to keep cron logic simple.
 */
export const listForCron = query({
  args: {
    userId: v.string(),
    statusFilter: v.union(v.literal("pending"), v.literal("done"), v.literal("archived")),
    dueAtFrom: v.number(),
    dueAtTo: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reminders")
      .withIndex("by_user_status_dueAt", (q) =>
        q.eq("userId", args.userId)
          .eq("status", args.statusFilter)
          .gte("dueAt", args.dueAtFrom)
          .lte("dueAt", args.dueAtTo),
      )
      .collect();
  },
});

export const listForUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const owned = await ctx.db
      .query("reminders")
      .withIndex("by_user_dueAt", (q) => q.eq("userId", args.userId))
      .collect();
    const participation = await ctx.db
      .query("reminderParticipants")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const shared: typeof owned = [];
    for (const p of participation) {
      const r = await ctx.db.get(p.reminderId);
      if (r) shared.push(r);
    }
    return { owned, shared };
  },
});

/**
 * Optimised query for the chat API.
 * Uses the by_user_status_dueAt compound index to fetch only pending reminders,
 * plus a small window of recently-done ones for context — avoiding a full table scan.
 * Shared (participant) reminders are still fetched and filtered in JS since they
 * don't have a user-level compound index.
 */
export const listForChat = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // All pending owned reminders (index-efficient)
    const pendingOwned = await ctx.db
      .query("reminders")
      .withIndex("by_user_status_dueAt", (q) =>
        q.eq("userId", args.userId).eq("status", "pending")
      )
      .collect();

    // Recently done (last 7 days) — for "did I already do X?" queries
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentDone = await ctx.db
      .query("reminders")
      .withIndex("by_user_status_dueAt", (q) =>
        q.eq("userId", args.userId).eq("status", "done")
      )
      .filter((q) => q.gte(q.field("updatedAt"), weekAgo))
      .collect();

    // Shared reminders (participant role) — fetch all, filter out archived in JS
    const participation = await ctx.db
      .query("reminderParticipants")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const shared: typeof pendingOwned = [];
    for (const p of participation) {
      const r = await ctx.db.get(p.reminderId);
      if (r && r.status !== "archived") shared.push(r);
    }

    return { owned: [...pendingOwned, ...recentDone], shared };
  },
});

export const listForTask = query({
  args: { userId: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.userId !== args.userId) return [];
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_linked_task", (q) => q.eq("linkedTaskId", args.taskId))
      .collect();
    return rows.filter((r) => r.userId === args.userId);
  },
});

export const create = mutation({
  args: {
    userId: v.string(),
    title: v.string(),
    notes: v.optional(v.string()),
    dueAt: v.number(),
    recurrence: v.optional(
      v.union(v.literal("none"), v.literal("daily"), v.literal("weekly"), v.literal("monthly"))
    ),
    priority: v.optional(v.number()),
    urgency: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    status: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("archived"))),
    linkedTaskId: v.optional(v.id("tasks")),
    domain: v.optional(lifeDomain),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    const now = Date.now();

    let linkedTaskId: Id<"tasks"> | undefined;
    if (args.linkedTaskId) {
      const t = await ctx.db.get(args.linkedTaskId);
      if (t && t.userId === args.userId) {
        linkedTaskId = args.linkedTaskId;
      }
    }

    const sameTime = await ctx.db
      .query("reminders")
      .withIndex("by_user_dueAt", (q) => q.eq("userId", args.userId).eq("dueAt", args.dueAt))
      .collect();

    const duplicate = sameTime.find(
      (item) =>
        item.status === "pending" && normalizeTitle(item.title) === normalizeTitle(title)
    );
    if (duplicate) {
      return { created: false, reminder: duplicate };
    }

    const id = await ctx.db.insert("reminders", {
      userId: args.userId,
      title,
      notes: args.notes?.trim() || undefined,
      dueAt: args.dueAt,
      status: args.status ?? "pending",
      recurrence: args.recurrence ?? "none",
      priority: args.priority,
      urgency: args.urgency,
      tags: args.tags?.filter((tag) => tag.trim().length > 0),
      linkedTaskId,
      domain: args.domain,
      createdAt: now,
      updatedAt: now,
    });

    const reminder = await ctx.db.get(id);
    return { created: true, reminder };
  },
});

export const update = mutation({
  args: {
    userId: v.string(),
    reminderId: v.id("reminders"),
    title: v.optional(v.string()),
    notes: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    status: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("archived"))),
    recurrence: v.optional(
      v.union(v.literal("none"), v.literal("daily"), v.literal("weekly"), v.literal("monthly"))
    ),
    priority: v.optional(v.number()),
    urgency: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    linkedTaskId: v.optional(v.union(v.id("tasks"), v.null())),
    domain: v.optional(v.union(lifeDomain, v.null())),
  },
  handler: async (ctx, args) => {
    const access = await getReminderAccess(ctx, args.reminderId, args.userId);
    if (!access) return null;
    const current = access.reminder;
    if (access.role !== "owner") {
      // Participants cannot change task link / domain on shared copies
      if (args.linkedTaskId !== undefined || args.domain !== undefined) return null;
    }

    let nextLinked: Id<"tasks"> | undefined = current.linkedTaskId;
    if (args.linkedTaskId !== undefined) {
      if (args.linkedTaskId === null) {
        nextLinked = undefined;
      } else {
        const t = await ctx.db.get(args.linkedTaskId);
        if (t && t.userId === args.userId) {
          nextLinked = args.linkedTaskId;
        }
      }
    }

    let nextDomain: typeof current.domain = current.domain;
    if (args.domain !== undefined) {
      nextDomain = args.domain === null ? undefined : args.domain;
    }

    await ctx.db.patch(args.reminderId, {
      title: args.title?.trim() ?? current.title,
      notes: args.notes?.trim() || undefined,
      dueAt: args.dueAt ?? current.dueAt,
      status: args.status ?? current.status,
      recurrence: args.recurrence ?? current.recurrence ?? "none",
      priority: args.priority ?? current.priority,
      urgency: args.urgency ?? current.urgency,
      tags: args.tags ?? current.tags,
      linkedTaskId: nextLinked,
      domain: nextDomain,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.reminderId);
  },
});

export const remove = mutation({
  args: { userId: v.string(), reminderId: v.id("reminders") },
  handler: async (ctx, args) => {
    const access = await getReminderAccess(ctx, args.reminderId, args.userId);
    if (!access) return { ok: false as const };
    const title = access.reminder.title;
    const ownerUserId = access.reminder.userId;
    await deleteReminderCascade(ctx, args.reminderId);
    return {
      ok: true as const,
      title,
      ownerUserId,
      actorWasOwner: access.role === "owner",
    };
  },
});

/**
 * Lightweight stats used by the smart-nudge cron to personalise messages.
 * Returns counts and the dominant domain for a user's pending reminders.
 */
export const getSmartNudgeStats = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("reminders")
      .withIndex("by_user_status_dueAt", (q) =>
        q.eq("userId", args.userId).eq("status", "pending"),
      )
      .collect();

    const overdueCount = pending.filter((r) => r.dueAt < now).length;
    const pendingCount = pending.length;

    // Find the domain with the most pending reminders.
    const domainCounts = new Map<string, number>();
    for (const r of pending) {
      if (r.domain) domainCounts.set(r.domain, (domainCounts.get(r.domain) ?? 0) + 1);
    }
    let topDomain: string | undefined;
    let topDomainCount = 0;
    for (const [d, c] of domainCounts) {
      if (c > topDomainCount) { topDomainCount = c; topDomain = d; }
    }

    // Next upcoming reminder (soonest future due date).
    const upcoming = pending
      .filter((r) => r.dueAt >= now)
      .sort((a, b) => a.dueAt - b.dueAt)[0];

    return {
      pendingCount,
      overdueCount,
      topDomain,
      nextDueTitle: upcoming?.title ?? null,
      nextDueAt: upcoming?.dueAt ?? null,
    };
  },
});

