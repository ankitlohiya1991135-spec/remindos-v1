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
import { mutation, query } from "./_generated/server";

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
          clickedAt?: number;
          createdAt: number;
        }>
      | undefined;
    // CTR (click-through rate): are notifications actually helping this user?
    let notificationCtr:
      | { sent: number; clicked: number; byType: Array<{ type: string; sent: number; clicked: number }> }
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
          ...(n.clickedAt ? { clickedAt: n.clickedAt } : {}),
          createdAt: n.createdAt,
        }));
      // Aggregate CTR — overall and per notification type.
      const byType = new Map<string, { sent: number; clicked: number }>();
      let sent = 0;
      let clicked = 0;
      for (const n of notifs) {
        sent += 1;
        const c = n.clickedAt ? 1 : 0;
        clicked += c;
        const entry = byType.get(n.type) ?? { sent: 0, clicked: 0 };
        entry.sent += 1;
        entry.clicked += c;
        byType.set(n.type, entry);
      }
      notificationCtr = {
        sent,
        clicked,
        byType: [...byType.entries()]
          .map(([type, v]) => ({ type, sent: v.sent, clicked: v.clicked }))
          .sort((a, b) => b.sent - a.sent),
      };
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

    // Session/usage timing (privacy-safe — no content). Pulls all session
    // rows and aggregates by window. With heartbeats merged into 5-minute
    // sessions and ~30d retention this stays bounded.
    const sessions = await ctx.db
      .query("userSessions")
      .withIndex("by_user_lastSeen", (q) => q.eq("userId", args.userId))
      .collect();
    let totalActiveMs = 0;
    let activeMs24h = 0;
    let activeMs7d = 0;
    let lastSeenAt: number | null = null;
    for (const s of sessions) {
      const dur = Math.max(0, s.lastSeenAt - s.startedAt);
      totalActiveMs += dur;
      if (s.lastSeenAt >= cutoff24h) {
        const start24 = Math.max(s.startedAt, cutoff24h);
        activeMs24h += Math.max(0, s.lastSeenAt - start24);
      }
      if (s.lastSeenAt >= cutoff7d) {
        const start7 = Math.max(s.startedAt, cutoff7d);
        activeMs7d += Math.max(0, s.lastSeenAt - start7);
      }
      if (lastSeenAt === null || s.lastSeenAt > lastSeenAt) {
        lastSeenAt = s.lastSeenAt;
      }
    }
    const sessionStats = {
      totalActiveMs,
      activeMs24h,
      activeMs7d,
      sessionCount: sessions.length,
      lastSeenAt,
    };

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
      sessionStats,
      ...(recentNotifications ? { recentNotifications } : {}),
      ...(notificationCtr ? { notificationCtr } : {}),
      ...(recentReminders ? { recentReminders } : {}),
    };
  },
});

// ──────────────────────────────────────────────────────────────────────
// AUDIT LOG — append-only.
// CRITICAL: there is intentionally NO delete/update mutation. The log
// must be tamper-evident.
// ──────────────────────────────────────────────────────────────────────

export const appendAuditEvent = mutation({
  args: {
    adminSecret: v.string(),
    actorUserId: v.string(),
    actorRole: v.literal("admin"),
    action: v.string(),
    targetUserId: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    outcome: v.union(v.literal("ok"), v.literal("error")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const id = await ctx.db.insert("adminAuditLog", {
      actorUserId: args.actorUserId,
      actorRole: args.actorRole,
      action: args.action,
      targetUserId: args.targetUserId,
      metadataJson: args.metadataJson,
      outcome: args.outcome,
      errorMessage: args.errorMessage,
      createdAt: Date.now(),
    });
    return String(id);
  },
});

export const listAuditEvents = query({
  args: {
    adminSecret: v.string(),
    limit: v.optional(v.number()),
    targetUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    const rows = args.targetUserId
      ? await ctx.db
          .query("adminAuditLog")
          .withIndex("by_target_created", (q) =>
            q.eq("targetUserId", args.targetUserId),
          )
          .collect()
      : await ctx.db
          .query("adminAuditLog")
          .withIndex("by_created")
          .collect();
    const sorted = rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    return sorted.map((r) => ({
      id: String(r._id),
      actorUserId: r.actorUserId,
      actorRole: r.actorRole,
      action: r.action,
      targetUserId: r.targetUserId,
      metadataJson: r.metadataJson,
      outcome: r.outcome,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
    }));
  },
});

// ──────────────────────────────────────────────────────────────────────
// BROADCASTS — admins can send and recall any broadcast.
// ──────────────────────────────────────────────────────────────────────

const broadcastSegment = v.union(
  v.literal("all"),
  v.literal("active_today"),
  v.literal("active_7d"),
  v.literal("admins_only"),
);

/**
 * Send a broadcast: inserts one row in `adminBroadcasts` PLUS one
 * `notifications` row per matched user. Caller must have already
 * resolved which userIds to notify (Clerk paginated user list).
 */
export const sendBroadcast = mutation({
  args: {
    adminSecret: v.string(),
    senderUserId: v.string(),
    senderRole: v.literal("admin"),
    title: v.string(),
    body: v.string(),
    segment: broadcastSegment,
    recipientUserIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const now = Date.now();

    // Insert broadcast metadata first.
    const broadcastId = await ctx.db.insert("adminBroadcasts", {
      senderUserId: args.senderUserId,
      senderRole: args.senderRole,
      title: args.title,
      body: args.body,
      segment: args.segment,
      recipientCount: args.recipientUserIds.length,
      createdAt: now,
    });

    // Then insert one notification per recipient.
    for (const uid of args.recipientUserIds) {
      await ctx.db.insert("notifications", {
        userId: uid,
        type: "admin_broadcast",
        title: args.title,
        body: args.body,
        read: false,
        createdAt: now,
      });
    }

    return String(broadcastId);
  },
});

export const listBroadcasts = query({
  args: {
    adminSecret: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const rows = await ctx.db.query("adminBroadcasts").collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => ({
        id: String(r._id),
        senderUserId: r.senderUserId,
        senderRole: r.senderRole,
        title: r.title,
        body: r.body,
        segment: r.segment,
        recipientCount: r.recipientCount,
        recalledAt: r.recalledAt ?? null,
        recalledBy: r.recalledBy ?? null,
        createdAt: r.createdAt,
      }));
  },
});

export const recallBroadcast = mutation({
  args: {
    adminSecret: v.string(),
    broadcastId: v.id("adminBroadcasts"),
    recallerUserId: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const row = await ctx.db.get(args.broadcastId);
    if (!row) {
      throw new ConvexError("Broadcast not found");
    }
    if (row.recalledAt) {
      // Idempotent: already recalled. Return without erroring so retries
      // (e.g. from a flaky network) don't show errors to the admin.
      return { ok: true, alreadyRecalled: true };
    }
    await ctx.db.patch(args.broadcastId, {
      recalledAt: Date.now(),
      recalledBy: args.recallerUserId,
    });

    // Also remove the recipient notification rows so users don't keep
    // seeing it. Match by type+title+body+createdAt — broadcasts don't
    // have a back-reference field so this is the cheap join.
    const matchingNotifs = await ctx.db
      .query("notifications")
      .filter((q) =>
        q.and(
          q.eq(q.field("type"), "admin_broadcast"),
          q.eq(q.field("createdAt"), row.createdAt),
        ),
      )
      .collect();
    for (const n of matchingNotifs) {
      // Defensive: only delete rows whose title+body match this broadcast.
      if (n.title === row.title && n.body === row.body) {
        await ctx.db.delete(n._id);
      }
    }

    return { ok: true, alreadyRecalled: false };
  },
});

// ──────────────────────────────────────────────────────────────────────
// PER-USER ACTIONS callable from admin endpoints.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// ADMIN NOTES on a user. Any admin can create, edit, or delete any note.
// ──────────────────────────────────────────────────────────────────────

export const listUserAdminNotes = query({
  args: {
    adminSecret: v.string(),
    targetUserId: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const rows = await ctx.db
      .query("userAdminNotes")
      .withIndex("by_target_created", (q) =>
        q.eq("targetUserId", args.targetUserId),
      )
      .collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        id: String(r._id),
        targetUserId: r.targetUserId,
        authorUserId: r.authorUserId,
        authorRole: r.authorRole,
        content: r.content,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  },
});

export const createUserAdminNote = mutation({
  args: {
    adminSecret: v.string(),
    targetUserId: v.string(),
    authorUserId: v.string(),
    authorRole: v.literal("admin"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const now = Date.now();
    const id = await ctx.db.insert("userAdminNotes", {
      targetUserId: args.targetUserId,
      authorUserId: args.authorUserId,
      authorRole: args.authorRole,
      content: args.content,
      createdAt: now,
      updatedAt: now,
    });
    return String(id);
  },
});

/**
 * Update a note. Any admin can edit any note.
 */
export const updateUserAdminNote = mutation({
  args: {
    adminSecret: v.string(),
    noteId: v.id("userAdminNotes"),
    callerUserId: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const row = await ctx.db.get(args.noteId);
    if (!row) throw new ConvexError("Note not found");
    await ctx.db.patch(args.noteId, {
      content: args.content,
      updatedAt: Date.now(),
    });
    return { ok: true, originalAuthor: row.authorUserId };
  },
});

export const deleteUserAdminNote = mutation({
  args: {
    adminSecret: v.string(),
    noteId: v.id("userAdminNotes"),
    callerUserId: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const row = await ctx.db.get(args.noteId);
    if (!row) throw new ConvexError("Note not found");
    await ctx.db.delete(args.noteId);
    return { ok: true, originalAuthor: row.authorUserId };
  },
});

// ──────────────────────────────────────────────────────────────────────
// ORG COST OVERVIEW — aggregate token estimate across the whole user base.
// ──────────────────────────────────────────────────────────────────────

export const orgCostOverview = query({
  args: {
    adminSecret: v.string(),
    userIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const CHARS_PER_TOKEN = 4;
    const INPUT_RATE_PER_1M = Number.parseFloat(
      process.env.NIM_INPUT_COST_PER_1M_TOKENS ?? "",
    ) || 0.4;
    const OUTPUT_RATE_PER_1M = Number.parseFloat(
      process.env.NIM_OUTPUT_COST_PER_1M_TOKENS ?? "",
    ) || 2.0;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const perUser: Array<{
      userId: string;
      totalTokens: number;
      estimatedCostUsd: number;
    }> = [];

    for (const userId of args.userIds) {
      const rows = await ctx.db
        .query("chatMessages")
        .withIndex("by_user_created", (q) => q.eq("userId", userId))
        .collect();
      let inputChars = 0;
      let outputChars = 0;
      for (const row of rows) {
        if (row.role === "assistant") outputChars += row.content.length;
        else inputChars += row.content.length;
      }
      const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
      const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      const cost =
        (inputTokens / 1_000_000) * INPUT_RATE_PER_1M +
        (outputTokens / 1_000_000) * OUTPUT_RATE_PER_1M;
      perUser.push({
        userId,
        totalTokens: inputTokens + outputTokens,
        estimatedCostUsd: Math.round(cost * 1_000_000) / 1_000_000,
      });
    }

    const totalCost =
      (totalInputTokens / 1_000_000) * INPUT_RATE_PER_1M +
      (totalOutputTokens / 1_000_000) * OUTPUT_RATE_PER_1M;

    perUser.sort((a, b) => b.totalTokens - a.totalTokens);
    const topSpenders = perUser.slice(0, 10);

    return {
      totalUsers: args.userIds.length,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      estimatedCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
      topSpenders,
    };
  },
});

/** Wipe a user's chat history. Admin-allowed. Audited at the API layer. */
export const resetUserChatHistory = mutation({
  args: {
    adminSecret: v.string(),
    targetUserId: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_user", (q) => q.eq("userId", args.targetUserId))
      .collect();
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted };
  },
});

/**
 * Delete EVERYTHING associated with a userId in Convex. Used by the
 * hard-delete flow AFTER the audit row is written and BEFORE
 * the Clerk delete call. We do NOT delete the audit log entries
 * referencing this user — the log stays intact.
 */
export const purgeAllUserData = mutation({
  args: {
    adminSecret: v.string(),
    targetUserId: v.string(),
  },
  handler: async (ctx, args) => {
    assertAdminSecret(args.adminSecret);
    const userId = args.targetUserId;
    let counts: Record<string, number> = {};

    const tablesToPurge: Array<{
      table: "chatMessages" | "reminders" | "tasks" | "notifications" | "userEvents" | "userProfiles" | "userWiki" | "pushSubscriptions" | "pushNotificationLogs" | "reminderParticipants" | "userSessions";
      index: string;
    }> = [
      { table: "chatMessages", index: "by_user" },
      { table: "reminders", index: "by_user_dueAt" },
      { table: "tasks", index: "by_user_status" },
      { table: "notifications", index: "by_user_created" },
      { table: "userEvents", index: "by_user_created" },
      { table: "userProfiles", index: "by_user" },
      { table: "userWiki", index: "by_user" },
      { table: "pushSubscriptions", index: "by_user" },
      { table: "reminderParticipants", index: "by_user" },
      { table: "userSessions", index: "by_user_lastSeen" },
    ];

    for (const t of tablesToPurge) {
      const rows = await ctx.db
        .query(t.table)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex(t.index as any, (q: any) => q.eq("userId", userId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
      counts[t.table] = rows.length;
    }

    return { counts };
  },
});
