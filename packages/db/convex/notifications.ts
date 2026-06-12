import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** Insert a notification into the in-app notification center. */
export const create = mutation({
  args: {
    userId: v.string(),
    type: v.string(),
    title: v.string(),
    body: v.string(),
    reminderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      reminderId: args.reminderId,
      read: false,
      createdAt: Date.now(),
    });
  },
});

/**
 * Record a CLICK on a push notification (for CTR). The push payload only carries
 * the notification `type` (+ optional reminderId), so we attribute the click to
 * the most recent matching, not-yet-clicked notification in the last 24h.
 * Also marks it read. Returns true if a row was attributed.
 */
export const markClickedByType = mutation({
  args: {
    userId: v.string(),
    type: v.string(),
    reminderId: v.optional(v.string()),
  },
  handler: async (ctx, { userId, type, reminderId }) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await ctx.db
      .query("notifications")
      .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", since))
      .order("desc")
      .take(60);
    const match = recent.find(
      (n) =>
        n.type === type &&
        !n.clickedAt &&
        (!reminderId || n.reminderId === reminderId),
    );
    if (!match) return false;
    await ctx.db.patch(match._id, { clickedAt: Date.now(), read: true });
    return true;
  },
});

/** List the most recent N notifications for a user (newest first). */
export const listForUser = query({
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit ?? 50);
    return rows;
  },
});

/** Count unread notifications for a user — drives the badge on the bell icon. */
export const unreadCount = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) =>
        q.eq("userId", args.userId).eq("read", false),
      )
      .collect();
    return rows.length;
  },
});

/** Mark a single notification as read. */
export const markRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { read: true });
  },
});

/** Mark all notifications for a user as read. */
export const markAllRead = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) =>
        q.eq("userId", args.userId).eq("read", false),
      )
      .collect();
    for (const n of unread) {
      await ctx.db.patch(n._id, { read: true });
    }
  },
});

/** Prune notifications older than 30 days. */
export const pruneOld = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("notifications")
      .withIndex("by_user_created", (q) =>
        q.eq("userId", args.userId).lt("createdAt", cutoff),
      )
      .take(200);
    for (const n of old) await ctx.db.delete(n._id);
  },
});
