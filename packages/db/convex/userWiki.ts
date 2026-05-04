import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ─── Valid page types ────────────────────────────────────────────────────────

export const WIKI_PAGE_TYPES = [
  "behavior_summary",
  "domain_health",
  "domain_finance",
  "domain_career",
  "domain_hobby",
  "domain_fun",
  "avoidance_patterns",
  "recent_week",
] as const;

export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Return all wiki pages for a user, keyed by pageType. */
export const getAll = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("userWiki")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    // Return as a plain object so the chat route can do wikiPages["behavior_summary"]
    const map: Record<string, { content: string; updatedAt: number }> = {};
    for (const row of rows) {
      map[row.pageType] = { content: row.content, updatedAt: row.updatedAt };
    }
    return map;
  },
});

/** Return the stalest updatedAt across all pages (or 0 if no pages exist yet). */
export const getOldestUpdatedAt = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("userWiki")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    if (rows.length === 0) return 0;
    return Math.min(...rows.map((r) => r.updatedAt));
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Insert or update a single wiki page. Content is capped at 1500 chars (~150 words). */
export const upsertPage = mutation({
  args: {
    userId: v.string(),
    pageType: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const content = args.content.slice(0, 1500).trim();
    const existing = await ctx.db
      .query("userWiki")
      .withIndex("by_user_page", (q) =>
        q.eq("userId", args.userId).eq("pageType", args.pageType)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { content, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("userWiki", {
        userId: args.userId,
        pageType: args.pageType,
        content,
        updatedAt: Date.now(),
      });
    }
  },
});

/** Delete all wiki pages for a user (used when account is reset). */
export const deleteAll = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("userWiki")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  },
});
