/**
 * Admin-only Convex queries.
 *
 * ⚠️ SECURITY ⚠️
 * Convex public queries are callable by anyone who knows the deployment URL,
 * which is exposed via `NEXT_PUBLIC_CONVEX_URL` in every browser bundle. To
 * prevent direct calls from a malicious client, every admin query here:
 *   1. Requires an `adminSecret` argument
 *   2. Verifies it (constant-time) against `process.env.ADMIN_CONVEX_SECRET`
 *   3. Throws on mismatch
 *
 * The Next.js admin API routes (which already verify admin role via Clerk)
 * inject this secret from server env. A leaked secret is the only attack
 * surface — rotate via the Convex dashboard if compromised.
 *
 * Combined with Clerk role gating in `apps/web/app/api/admin/*`, this gives
 * defence-in-depth: Clerk role check (Next.js) AND shared secret (Convex).
 */

import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Constant-time string comparison. Mitigates timing attacks on the secret.
 * Convex runs in V8 isolates without `crypto.timingSafeEqual`, so we DIY.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function assertAdminSecret(provided: string): void {
  const expected = process.env.ADMIN_CONVEX_SECRET;
  if (!expected || expected.length < 16) {
    // Misconfigured server — refuse rather than allowing weak/empty secrets.
    throw new ConvexError("Admin secret not configured");
  }
  if (!constantTimeEqual(provided, expected)) {
    throw new ConvexError("Forbidden");
  }
}

/**
 * Aggregate chat-message activity stats for a list of userIds.
 * Returns a map keyed by userId so callers can join with the Clerk user list
 * without an N+1 round-trip.
 */
export const activityForUsers = query({
  args: {
    userIds: v.array(v.string()),
    adminSecret: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const now = Date.now();
    const cutoff24h = now - DAY_MS;
    const cutoff7d = now - 7 * DAY_MS;
    // For "active today", use 00:00 UTC of today as the boundary. We can't
    // know each viewer's timezone here; the route layer can recompute if it
    // needs a different definition.
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const todayBoundary = startOfTodayUtc.getTime();

    const result: Record<
      string,
      {
        totalPrompts: number;
        promptsLast24h: number;
        promptsLast7d: number;
        activeToday: boolean;
        lastPromptAt: number | null;
      }
    > = {};

    for (const userId of args.userIds) {
      const rows = await ctx.db
        .query("chatMessages")
        .withIndex("by_user_created", (q) => q.eq("userId", userId))
        .collect();

      let totalPrompts = 0;
      let promptsLast24h = 0;
      let promptsLast7d = 0;
      let activeToday = false;
      let lastPromptAt: number | null = null;

      for (const row of rows) {
        if (row.role !== "user") continue;
        totalPrompts++;
        if (row.createdAt >= cutoff24h) promptsLast24h++;
        if (row.createdAt >= cutoff7d) promptsLast7d++;
        if (row.createdAt >= todayBoundary) activeToday = true;
        if (lastPromptAt === null || row.createdAt > lastPromptAt) {
          lastPromptAt = row.createdAt;
        }
      }

      result[userId] = {
        totalPrompts,
        promptsLast24h,
        promptsLast7d,
        activeToday,
        lastPromptAt,
      };
    }

    return result;
  },
});

/**
 * Detailed activity for a single user — used by the user-detail page.
 * Returns recent prompts (truncated previews), reminder/task counts, and a
 * 14-day daily prompt histogram.
 */
export const userActivityDetail = query({
  args: {
    userId: v.string(),
    adminSecret: v.string(),
    promptLimit: v.optional(v.number()),
    previewLength: v.optional(v.number()),
    /** Superadmin-only: include recent notifications. */
    includeNotifications: v.optional(v.boolean()),
    /** Superadmin-only: include recent reminders. */
    includeReminders: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const promptLimit = Math.min(Math.max(args.promptLimit ?? 50, 1), 200);
    const previewLength = Math.min(Math.max(args.previewLength ?? 200, 20), 500);
    const CHARS_PER_TOKEN = 4;
    const INPUT_RATE_PER_1M = Number.parseFloat(
      process.env.NIM_INPUT_COST_PER_1M_TOKENS ?? "",
    ) || 0.4;
    const OUTPUT_RATE_PER_1M = Number.parseFloat(
      process.env.NIM_OUTPUT_COST_PER_1M_TOKENS ?? "",
    ) || 2.0;

    const now = Date.now();
    const cutoff24h = now - DAY_MS;
    const cutoff7d = now - 7 * DAY_MS;
    const cutoff14d = now - 14 * DAY_MS;

    const chatRows = await ctx.db
      .query("chatMessages")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .collect();

    let totalPrompts = 0;
    let promptsLast24h = 0;
    let promptsLast7d = 0;
    let inputChars = 0;
    let outputChars = 0;
    const recentByCreatedAt = [...chatRows].sort(
      (a, b) => b.createdAt - a.createdAt,
    );

    for (const row of chatRows) {
      // Token estimation: assistant text → output, user/system → input.
      if (row.role === "assistant") outputChars += row.content.length;
      else inputChars += row.content.length;

      if (row.role !== "user") continue;
      totalPrompts++;
      if (row.createdAt >= cutoff24h) promptsLast24h++;
      if (row.createdAt >= cutoff7d) promptsLast7d++;
    }

    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
    const estimatedCostUsd =
      (inputTokens / 1_000_000) * INPUT_RATE_PER_1M +
      (outputTokens / 1_000_000) * OUTPUT_RATE_PER_1M;
    const tokenEstimate = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
    };

    const recentPrompts = recentByCreatedAt.slice(0, promptLimit).map((row) => ({
      clientId: row.clientId,
      role: row.role,
      contentPreview:
        row.content.length > previewLength
          ? `${row.content.slice(0, previewLength)}…`
          : row.content,
      createdAt: row.createdAt,
    }));

    // 14-day daily histogram (UTC days)
    const dailyMap = new Map<string, number>();
    for (let i = 0; i < 14; i++) {
      const d = new Date(now - i * DAY_MS);
      d.setUTCHours(0, 0, 0, 0);
      dailyMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const row of chatRows) {
      if (row.role !== "user") continue;
      if (row.createdAt < cutoff14d) continue;
      const key = new Date(row.createdAt).toISOString().slice(0, 10);
      if (dailyMap.has(key)) dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
    }
    const dailyPromptCounts = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    // Reminder + task counts (lifetime; cheap with index)
    const reminders = await ctx.db
      .query("reminders")
      .withIndex("by_user_dueAt", (q) => q.eq("userId", args.userId))
      .collect();
    const remindersCreated = reminders.length;
    const remindersCompleted = reminders.filter(
      (r) => r.status === "done",
    ).length;

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId))
      .collect();
    const tasksCreated = tasks.length;
    const tasksCompleted = tasks.filter((t) => t.status === "done").length;

    // Superadmin-only payloads.
    let recentNotifications:
      | Array<{
          id: string;
          type: string;
          title: string;
          body: string;
          read: boolean;
          createdAt: number;
        }>
      | undefined;
    let recentReminders:
      | Array<{
          id: string;
          title: string;
          status: string;
          dueAt: number;
          createdAt: number;
        }>
      | undefined;

    if (args.includeNotifications) {
      const notifs = await ctx.db
        .query("notifications")
        .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
        .collect();
      recentNotifications = notifs
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 25)
        .map((n) => ({
          id: String(n._id),
          type: n.type,
          title: n.title,
          body: n.body,
          read: n.read,
          createdAt: n.createdAt,
        }));
    }

    if (args.includeReminders) {
      recentReminders = [...reminders]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 25)
        .map((r) => ({
          id: String(r._id),
          title: r.title,
          status: r.status,
          dueAt: r.dueAt,
          createdAt: r.createdAt,
        }));
    }

    return {
      userId: args.userId,
      totalPrompts,
      promptsLast24h,
      promptsLast7d,
      remindersCreated,
      remindersCompleted,
      tasksCreated,
      tasksCompleted,
      recentPrompts,
      dailyPromptCounts,
      tokenEstimate,
      ...(recentNotifications ? { recentNotifications } : {}),
      ...(recentReminders ? { recentReminders } : {}),
    };
  },
});
