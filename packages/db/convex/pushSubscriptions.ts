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
    /** Opt-in for smart engagement nudges. */
    smartNudgeEnabled: v.optional(v.boolean()),
    /** IANA timezone string e.g. "Asia/Kolkata". */
    timeZone: v.optional(v.string()),
    /** User display name for personalised nudge copy. */
    displayName: v.optional(v.string()),
    /** UTC hour for morning briefing push (0-23). Default 2 = 7:30 AM IST. */
    morningBriefingHourUtc: v.optional(v.number()),
    /** Local hour to start quiet window. Default 22 (10 PM). */
    quietStartHour: v.optional(v.number()),
    /** Local hour to end quiet window. Default 8 (8 AM). */
    quietEndHour: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    const now = Date.now();
    const extra = {
      ...(args.preDueMinutes !== undefined ? { preDueMinutes: args.preDueMinutes } : {}),
      ...(args.smartNudgeEnabled !== undefined ? { smartNudgeEnabled: args.smartNudgeEnabled } : {}),
      ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
      ...(args.morningBriefingHourUtc !== undefined ? { morningBriefingHourUtc: args.morningBriefingHourUtc } : {}),
      ...(args.quietStartHour !== undefined ? { quietStartHour: args.quietStartHour } : {}),
      ...(args.quietEndHour !== undefined ? { quietEndHour: args.quietEndHour } : {}),
    };
    if (existing) {
      if (existing.userId !== args.userId) {
        await ctx.db.delete(existing._id);
      } else {
        await ctx.db.patch(existing._id, { p256dh: args.p256dh, auth: args.auth, createdAt: now, ...extra });
        return { ok: true as const };
      }
    }
    await ctx.db.insert("pushSubscriptions", {
      userId: args.userId,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      createdAt: now,
      ...extra,
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
 * Returns per-user subscription metadata needed by both cron routes.
 * Includes timing prefs so each cron can respect per-user schedules.
 */
export const listAllUsers = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("pushSubscriptions").collect();
    return rows.map((r) => ({
      userId: r.userId,
      endpoint: r.endpoint,
      preDueMinutes: r.preDueMinutes,
      smartNudgeEnabled: r.smartNudgeEnabled,
      timeZone: r.timeZone,
      displayName: r.displayName,
      morningBriefingHourUtc: r.morningBriefingHourUtc,
      quietStartHour: r.quietStartHour,
      quietEndHour: r.quietEndHour,
    }));
  },
});
