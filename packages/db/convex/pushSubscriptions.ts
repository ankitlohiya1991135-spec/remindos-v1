import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const savePushSubscription = mutation({
  args: {
    userId: v.string(),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    /** Minutes before due to fire a pre-due push (0 = disabled). */
    preDueMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    const now = Date.now();
    if (existing) {
      if (existing.userId !== args.userId) {
        await ctx.db.delete(existing._id);
      } else {
        await ctx.db.patch(existing._id, {
          p256dh: args.p256dh,
          auth: args.auth,
          createdAt: now,
          ...(args.preDueMinutes !== undefined ? { preDueMinutes: args.preDueMinutes } : {}),
        });
        return { ok: true as const };
      }
    }
    await ctx.db.insert("pushSubscriptions", {
      userId: args.userId,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      createdAt: now,
      ...(args.preDueMinutes !== undefined ? { preDueMinutes: args.preDueMinutes } : {}),
    });
    return { ok: true as const };
  },
});

export const removePushSubscription = mutation({
  args: { userId: v.string(), endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (!existing || existing.userId !== args.userId) return { ok: false as const };
    await ctx.db.delete(existing._id);
    return { ok: true as const };
  },
});

export const listForUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

/**
 * Returns the unique userId + endpoint for every subscription in the table.
 * Used by the push cron to discover which users have push enabled.
 * Only returns the userId + endpoint fields to keep the payload small.
 */
export const listAllUsers = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("pushSubscriptions").collect();
    return rows.map((r) => ({
      userId: r.userId,
      endpoint: r.endpoint,
      preDueMinutes: r.preDueMinutes,
    }));
  },
});
