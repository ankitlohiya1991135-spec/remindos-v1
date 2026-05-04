/**
 * POST /api/wiki/sync
 *
 * Deterministic wiki page builder — no LLM calls, zero extra API cost.
 * Called fire-and-forget after every reminder create / done / delete.
 * Also called from the chat route when wiki pages are stale (> 1 hour old).
 *
 * Reads:  userEvents (30 days), userProfiles, reminders (pending + recent done)
 * Writes: userWiki pages via Convex upsertPage mutation
 */

import { auth } from "@clerk/nextjs/server";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../../lib/server/convex-client";

// ─── Types ───────────────────────────────────────────────────────────────────

type EventRow = {
  eventType: string;
  entityTitle?: string;
  domain?: string;
  createdAt: number;
  metadata?: string;
};

type ReminderRow = {
  title: string;
  status: string;
  domain?: string;
  dueAt: number;
  updatedAt: number;
  priority?: number;
};

type ProfileRow = {
  preferredWorkingHoursStart?: number;
  preferredWorkingHoursEnd?: number;
  dominantDomain?: string;
  avgCompletionDelayMinutes?: number;
  topTags?: string[];
} | null;

const DOMAINS = ["health", "finance", "career", "hobby", "fun"] as const;
type Domain = (typeof DOMAINS)[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(n: number, d: number) {
  if (d === 0) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

function hourLabel(h: number) {
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  const suffix = h >= 12 ? "pm" : "am";
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

function dayName(dayIndex: number) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayIndex] ?? "?";
}

function statusIcon(rate: number) {
  if (rate >= 75) return "✅";
  if (rate >= 40) return "⚠️";
  return "🔴";
}

// ─── Page builders ───────────────────────────────────────────────────────────

function buildBehaviorSummary(
  events: EventRow[],
  profile: ProfileRow,
): string {
  const created = events.filter((e) => e.eventType === "reminder_created");
  const completed = events.filter((e) => e.eventType === "reminder_completed");
  const deleted = events.filter((e) => e.eventType === "reminder_deleted");

  const totalCreated = created.length;
  const totalDone = completed.length;
  const totalDeleted = deleted.length;
  const completionRate = Math.round(totalCreated > 0 ? (totalDone / totalCreated) * 100 : 0);

  // Day-of-week activity
  const dayCounts: number[] = Array(7).fill(0);
  for (const e of completed) {
    dayCounts[new Date(e.createdAt).getDay()]! += 1;
  }
  const busiestDayIdx = dayCounts.indexOf(Math.max(...dayCounts));
  const busiestDay = dayCounts[busiestDayIdx]! > 0 ? dayName(busiestDayIdx) : null;

  // Domain breakdown
  const domainCreated: Record<string, number> = {};
  const domainDone: Record<string, number> = {};
  for (const e of created) {
    if (e.domain) domainCreated[e.domain] = (domainCreated[e.domain] ?? 0) + 1;
  }
  for (const e of completed) {
    if (e.domain) domainDone[e.domain] = (domainDone[e.domain] ?? 0) + 1;
  }

  const domainLines = DOMAINS
    .filter((d) => (domainCreated[d] ?? 0) > 0)
    .map((d) => {
      const rate = Math.round(((domainDone[d] ?? 0) / (domainCreated[d] ?? 1)) * 100);
      return `${d} ${pct(domainDone[d] ?? 0, domainCreated[d] ?? 1)} ${statusIcon(rate)}`;
    });

  // Working hours from profile
  const hoursLine =
    profile?.preferredWorkingHoursStart != null && profile?.preferredWorkingHoursEnd != null
      ? `Working hours: ${hourLabel(profile.preferredWorkingHoursStart)}–${hourLabel(profile.preferredWorkingHoursEnd)}.`
      : "";

  const topTags = profile?.topTags?.slice(0, 5).join(", ");

  const lines = [
    `[Behavior Summary — last 30 days]`,
    `Created: ${totalCreated} | Completed: ${totalDone} (${completionRate}%) | Deleted: ${totalDeleted}`,
    domainLines.length > 0 ? `Domains: ${domainLines.join(" | ")}` : "",
    busiestDay ? `Most active day: ${busiestDay}` : "",
    hoursLine,
    topTags ? `Top tags: ${topTags}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildDomainPage(domain: Domain, events: EventRow[], reminders: ReminderRow[]): string {
  const created = events.filter((e) => e.eventType === "reminder_created" && e.domain === domain);
  const completed = events.filter((e) => e.eventType === "reminder_completed" && e.domain === domain);
  const deleted = events.filter((e) => e.eventType === "reminder_deleted" && e.domain === domain);

  if (created.length === 0 && completed.length === 0) return "";

  // Average hour of creation for this domain
  const hours = created.map((e) => new Date(e.createdAt).getHours());
  const avgHour = hours.length > 0 ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null;

  // Common title words (top 3)
  const wordFreq: Record<string, number> = {};
  for (const e of [...created, ...completed]) {
    const words = (e.entityTitle ?? "").toLowerCase().split(/\s+/);
    for (const w of words) {
      if (w.length > 3) wordFreq[w] = (wordFreq[w] ?? 0) + 1;
    }
  }
  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);

  // Last completed title
  const lastDone = completed.sort((a, b) => b.createdAt - a.createdAt)[0];

  // Pending reminders in this domain
  const pendingInDomain = reminders.filter(
    (r) => r.domain === domain && r.status === "pending"
  ).length;

  const rate = created.length > 0 ? Math.round((completed.length / created.length) * 100) : 0;

  const lines = [
    `[${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain]`,
    `Created: ${created.length} | Completed: ${completed.length} (${rate}%) | Deleted: ${deleted.length}`,
    avgHour !== null ? `Typical time: ${hourLabel(avgHour)}` : "",
    topWords.length > 0 ? `Common topics: ${topWords.join(", ")}` : "",
    lastDone?.entityTitle ? `Last completed: "${lastDone.entityTitle}"` : "",
    pendingInDomain > 0 ? `Currently pending: ${pendingInDomain} reminder${pendingInDomain !== 1 ? "s" : ""}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildAvoidancePatterns(events: EventRow[]): string {
  const created = events.filter((e) => e.eventType === "reminder_created" && e.entityTitle);
  const completed = events.filter((e) => e.eventType === "reminder_completed" && e.entityTitle);
  const deleted = events.filter((e) => e.eventType === "reminder_deleted" && e.entityTitle);

  // Find titles that were created multiple times but never completed
  const createdTitles: Record<string, number> = {};
  const completedTitles = new Set(completed.map((e) => e.entityTitle!.toLowerCase().trim()));
  const deletedTitles: Record<string, number> = {};

  for (const e of created) {
    const t = e.entityTitle!.toLowerCase().trim();
    createdTitles[t] = (createdTitles[t] ?? 0) + 1;
  }
  for (const e of deleted) {
    const t = e.entityTitle!.toLowerCase().trim();
    deletedTitles[t] = (deletedTitles[t] ?? 0) + 1;
  }

  // Avoidance = created 2+ times AND never completed AND deleted at least once
  const avoided = Object.entries(createdTitles)
    .filter(([title, count]) => count >= 2 && !completedTitles.has(title) && deletedTitles[title])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Also: created once, deleted, never done — "single avoidance"
  const singleAvoided = Object.entries(createdTitles)
    .filter(([title, count]) => count === 1 && !completedTitles.has(title) && deletedTitles[title])
    .sort((a, b) => (deletedTitles[b[0]] ?? 0) - (deletedTitles[a[0]] ?? 0))
    .slice(0, 3);

  const lines = ["[Avoidance Patterns]"];

  if (avoided.length === 0 && singleAvoided.length === 0) {
    lines.push("No avoidance patterns detected. User completes or keeps all created reminders.");
    return lines.join("\n");
  }

  if (avoided.length > 0) {
    lines.push("Repeatedly created but never completed:");
    for (const [title, count] of avoided) {
      lines.push(`  - "${title}" — created ${count}x, deleted ${deletedTitles[title] ?? 0}x, never done`);
    }
  }

  if (singleAvoided.length > 0) {
    lines.push("Created then deleted (possible friction):");
    for (const [title] of singleAvoided) {
      lines.push(`  - "${title}"`);
    }
  }

  return lines.join("\n");
}

function buildRecentWeek(events: EventRow[], reminders: ReminderRow[]): string {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = events.filter((e) => e.createdAt >= weekAgo);

  const created = recent.filter((e) => e.eventType === "reminder_created").length;
  const completed = recent.filter((e) => e.eventType === "reminder_completed").length;
  const deleted = recent.filter((e) => e.eventType === "reminder_deleted").length;

  // Best day this week
  const dayCounts: Record<number, number> = {};
  for (const e of recent.filter((e) => e.eventType === "reminder_completed")) {
    const d = new Date(e.createdAt).getDay();
    dayCounts[d] = (dayCounts[d] ?? 0) + 1;
  }
  const bestDayEntry = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
  const bestDay = bestDayEntry ? dayName(parseInt(bestDayEntry[0])) : null;

  // Pending reminders older than 7 days (carryover)
  const carryover = reminders.filter(
    (r) => r.status === "pending" && r.dueAt < weekAgo
  ).length;

  // Overdue (past due but still pending)
  const now = Date.now();
  const overdue = reminders.filter(
    (r) => r.status === "pending" && r.dueAt < now
  ).length;

  const rate = created > 0 ? Math.round((completed / created) * 100) : 0;

  const lines = [
    `[Recent 7 Days]`,
    `Created: ${created} | Completed: ${completed} (${rate}%) | Deleted: ${deleted}`,
    bestDay && completed > 0 ? `Best day: ${bestDay} (${bestDayEntry![1]} done)` : "",
    overdue > 0 ? `Overdue right now: ${overdue} reminder${overdue !== 1 ? "s" : ""}` : "No overdue reminders right now.",
    carryover > 0 ? `Carryover from before this week: ${carryover} still pending` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // Support both authenticated calls (from UI) and internal calls (from other routes)
  // For internal calls, userId is passed in the body with a shared secret.
  let userId: string | null = null;

  const internalSecret = process.env.WIKI_SYNC_SECRET;
  let bodyUserId: string | undefined;

  try {
    const body = (await request.json()) as { userId?: string; secret?: string };
    if (internalSecret && body.secret === internalSecret && body.userId) {
      userId = body.userId;
      bodyUserId = body.userId;
    }
  } catch {
    // body may be empty for auth'd calls
  }

  if (!userId) {
    const { userId: authUserId } = await auth();
    if (!authUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    userId = authUserId;
  }

  try {
    const client = getConvexClient();

    // Load all data in parallel
    const [events, profile, rawReminders] = await Promise.all([
      client.query(api.userEvents.getRecent, { userId, limitDays: 30 }),
      client.query(api.userProfiles.get, { userId }),
      client.query(api.reminders.listForChat, { userId }),
    ]);

    const typedEvents = (events as EventRow[]);
    const typedProfile = profile as ProfileRow;
    const reminders: ReminderRow[] = [
      ...(rawReminders as { owned: ReminderRow[]; shared: ReminderRow[] }).owned,
      ...(rawReminders as { owned: ReminderRow[]; shared: ReminderRow[] }).shared,
    ];

    // Build all pages
    const pages: Array<{ pageType: string; content: string }> = [];

    // 1. Behavior summary
    const behaviorContent = buildBehaviorSummary(typedEvents, typedProfile);
    if (behaviorContent) pages.push({ pageType: "behavior_summary", content: behaviorContent });

    // 2. Per-domain pages
    for (const domain of DOMAINS) {
      const content = buildDomainPage(domain, typedEvents, reminders);
      if (content) pages.push({ pageType: `domain_${domain}`, content });
    }

    // 3. Avoidance patterns
    const avoidanceContent = buildAvoidancePatterns(typedEvents);
    if (avoidanceContent) pages.push({ pageType: "avoidance_patterns", content: avoidanceContent });

    // 4. Recent week
    const recentContent = buildRecentWeek(typedEvents, reminders);
    if (recentContent) pages.push({ pageType: "recent_week", content: recentContent });

    // Write all pages (parallel fire-and-forget — each is independent)
    await Promise.all(
      pages.map((p) =>
        client.mutation(api.userWiki.upsertPage, {
          userId: userId!,
          pageType: p.pageType,
          content: p.content,
        })
      )
    );

    return NextResponse.json({ ok: true, pagesWritten: pages.length });
  } catch (err) {
    // Never crash the caller — wiki sync is best-effort
    console.error("[wiki/sync] error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
