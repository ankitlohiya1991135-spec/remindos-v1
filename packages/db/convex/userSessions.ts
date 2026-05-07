import { v } from "convex/values";
import { mutation } from "./_generated/server";

/** Heartbeats within this gap are merged into one session. */
const SESSION_GAP_MS = 5 * 60 * 1000;

/**
 * Extend the user's most-recent session, or start a new one if the gap
 * since their last heartbeat exceeds SESSION_GAP_MS. Called from the
 * client tracker every ~60s while the tab is visible. Stores no content —
 * just timing.
 */
export const heartbeat = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const latest = await ctx.db
      .query("userSessions")
      .withIndex("by_user_lastSeen", (q) => q.eq("userId", args.userId))
      .order("desc")
      .first();

    if (latest && now - latest.lastSeenAt <= SESSION_GAP_MS) {
      await ctx.db.patch(latest._id, { lastSeenAt: now });
      return { sessionId: String(latest._id), extended: true };
    }

    const id = await ctx.db.insert("userSessions", {
      userId: args.userId,
      startedAt: now,
      lastSeenAt: now,
    });
    return { sessionId: String(id), extended: false };
  },
});
