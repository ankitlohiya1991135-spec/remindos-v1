/**
 * Shared server-side wiki sync function.
 *
 * Called directly from reminders API routes and the chat route — no HTTP roundtrip.
 * The POST /api/wiki/sync route is now just a thin wrapper around this.
 *
 * All page builders are deterministic (no LLM calls, zero extra API cost).
 */

import { api } from "@repo/db/convex/api";
import { getConvexClient } from "./convex-client";

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
  notes?: string;
  recurrence?: string;
};

type TaskRow = {
  title: string;
  status: string;
  domain?: string;
  priority?: number;
  dueAt?: number;
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

function buildBehaviorSummary(events: EventRow[], profile: ProfileRow): string {
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
  const maxDay = Math.max(...dayCounts);
  const busiestDayIdx = maxDay > 0 ? dayCounts.indexOf(maxDay) : -1;
  const busiestDay = busiestDayIdx >= 0 ? dayName(busiestDayIdx) : null;

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

  const hoursLine =
    profile?.preferredWorkingHoursStart != null && profile?.preferredWorkingHoursEnd != null
      ? `Working hours: ${hourLabel(profile.preferredWorkingHoursStart)}–${hourLabel(profile.preferredWorkingHoursEnd)}.`
      : "";

  const topTags = profile?.topTags?.slice(0, 5).join(", ");

  // New-user stub when no events yet
  if (totalCreated === 0) {
    return [
      `[Behavior Summary]`,
      `New user — no reminder history yet.`,
      hoursLine,
    ].filter(Boolean).join("\n");
  }

  return [
    `[Behavior Summary — last 30 days]`,
    `Created: ${totalCreated} | Completed: ${totalDone} (${completionRate}%) | Deleted: ${totalDeleted}`,
    domainLines.length > 0 ? `Domains: ${domainLines.join(" | ")}` : "",
    busiestDay ? `Most active day: ${busiestDay}` : "",
    hoursLine,
    topTags ? `Top tags: ${topTags}` : "",
  ].filter(Boolean).join("\n");
}

function buildDomainPage(domain: Domain, events: EventRow[], reminders: ReminderRow[]): string {
  const created = events.filter((e) => e.eventType === "reminder_created" && e.domain === domain);
  const completed = events.filter((e) => e.eventType === "reminder_completed" && e.domain === domain);
  const deleted = events.filter((e) => e.eventType === "reminder_deleted" && e.domain === domain);

  // Include pending reminders for this domain even if no events yet
  const pendingInDomain = reminders.filter((r) => r.domain === domain && r.status === "pending");

  if (created.length === 0 && completed.length === 0 && pendingInDomain.length === 0) return "";

  const hours = created.map((e) => new Date(e.createdAt).getHours());
  const avgHour = hours.length > 0 ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null;

  // Common title words
  const wordFreq: Record<string, number> = {};
  for (const e of [...created, ...completed]) {
    for (const w of (e.entityTitle ?? "").toLowerCase().split(/\s+/)) {
      if (w.length > 3) wordFreq[w] = (wordFreq[w] ?? 0) + 1;
    }
  }
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);

  const lastDone = [...completed].sort((a, b) => b.createdAt - a.createdAt)[0];
  const rate = created.length > 0 ? Math.round((completed.length / created.length) * 100) : 0;

  // Pending reminder details (title + priority flag)
  const pendingDetails = pendingInDomain.slice(0, 3).map((r) => {
    const pri = r.priority != null && r.priority >= 4 ? " [high priority]" : "";
    const rec = r.recurrence && r.recurrence !== "none" ? ` [${r.recurrence}]` : "";
    return `"${r.title}"${pri}${rec}`;
  });

  return [
    `[${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain]`,
    created.length > 0
      ? `Created: ${created.length} | Completed: ${completed.length} (${rate}%) | Deleted: ${deleted.length}`
      : `No history yet.`,
    avgHour !== null ? `Typical time: ${hourLabel(avgHour)}` : "",
    topWords.length > 0 ? `Common topics: ${topWords.join(", ")}` : "",
    lastDone?.entityTitle ? `Last completed: "${lastDone.entityTitle}"` : "",
    pendingInDomain.length > 0
      ? `Pending: ${pendingDetails.join(", ")}${pendingInDomain.length > 3 ? ` (+${pendingInDomain.length - 3} more)` : ""}`
      : "",
  ].filter(Boolean).join("\n");
}

function buildAvoidancePatterns(events: EventRow[]): string {
  const created = events.filter((e) => e.eventType === "reminder_created" && e.entityTitle);
  const completed = events.filter((e) => e.eventType === "reminder_completed" && e.entityTitle);
  const deleted = events.filter((e) => e.eventType === "reminder_deleted" && e.entityTitle);

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

  const avoided = Object.entries(createdTitles)
    .filter(([title, count]) => count >= 2 && !completedTitles.has(title) && deletedTitles[title])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const singleAvoided = Object.entries(createdTitles)
    .filter(([title, count]) => count === 1 && !completedTitles.has(title) && deletedTitles[title])
    .sort((a, b) => (deletedTitles[b[0]] ?? 0) - (deletedTitles[a[0]] ?? 0))
    .slice(0, 3);

  const lines = ["[Avoidance Patterns]"];
  if (avoided.length === 0 && singleAvoided.length === 0) {
    lines.push("No avoidance patterns detected yet.");
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

  const dayCounts: Record<number, number> = {};
  for (const e of recent.filter((e) => e.eventType === "reminder_completed")) {
    const d = new Date(e.createdAt).getDay();
    dayCounts[d] = (dayCounts[d] ?? 0) + 1;
  }
  const bestDayEntry = Object.entries(dayCounts).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  const bestDay = bestDayEntry ? dayName(parseInt(bestDayEntry[0])) : null;

  const now = Date.now();
  const overdue = reminders.filter((r) => r.status === "pending" && r.dueAt < now).length;
  const carryover = reminders.filter((r) => r.status === "pending" && r.dueAt < weekAgo).length;
  const rate = created > 0 ? Math.round((completed / created) * 100) : 0;

  return [
    `[Recent 7 Days]`,
    created === 0 && completed === 0
      ? "No reminder activity in the last 7 days."
      : `Created: ${created} | Completed: ${completed} (${rate}%) | Deleted: ${deleted}`,
    bestDay && completed > 0 ? `Best day: ${bestDay} (${bestDayEntry![1]} done)` : "",
    overdue > 0 ? `Overdue right now: ${overdue} reminder${overdue !== 1 ? "s" : ""}` : "No overdue reminders.",
    carryover > 0 ? `Carryover from before this week: ${carryover} still pending` : "",
  ].filter(Boolean).join("\n");
}

function buildTasksSummary(tasks: TaskRow[]): string {
  if (tasks.length === 0) return "";
  const pending = tasks.filter((t) => t.status === "pending");
  const done = tasks.filter((t) => t.status === "done");
  const highPri = pending.filter((t) => (t.priority ?? 0) >= 4);

  const domainCounts: Record<string, number> = {};
  for (const t of pending) {
    if (t.domain) domainCounts[t.domain] = (domainCounts[t.domain] ?? 0) + 1;
  }
  const domainLine = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d}(${n})`)
    .join(", ");

  return [
    `[Tasks Summary]`,
    `Pending: ${pending.length} | Done: ${done.length}`,
    highPri.length > 0
      ? `High priority: ${highPri.slice(0, 3).map((t) => `"${t.title}"`).join(", ")}`
      : "",
    domainLine ? `By domain: ${domainLine}` : "",
  ].filter(Boolean).join("\n");
}

// ─── Main sync function ───────────────────────────────────────────────────────

export async function syncUserWiki(userId: string): Promise<{ pagesWritten: number }> {
  const client = getConvexClient();

  const [events, profile, rawReminders, rawTasks] = await Promise.all([
    client.query(api.userEvents.getRecent, { userId, limitDays: 30 }),
    client.query(api.userProfiles.get, { userId }),
    client.query(api.reminders.listForChat, { userId }),
    client.query(api.tasks.listForUser, { userId }),
  ]);

  const typedEvents = events as EventRow[];
  const typedProfile = profile as ProfileRow;
  const reminders: ReminderRow[] = [
    ...(rawReminders as { owned: ReminderRow[]; shared: ReminderRow[] }).owned,
    ...(rawReminders as { owned: ReminderRow[]; shared: ReminderRow[] }).shared,
  ];
  const tasks = (rawTasks as TaskRow[]);

  const pages: Array<{ pageType: string; content: string }> = [];

  // 1. Behavior summary (always built — has new-user stub)
  pages.push({ pageType: "behavior_summary", content: buildBehaviorSummary(typedEvents, typedProfile) });

  // 2. Per-domain pages
  for (const domain of DOMAINS) {
    const content = buildDomainPage(domain, typedEvents, reminders);
    if (content) pages.push({ pageType: `domain_${domain}`, content });
  }

  // 3. Avoidance patterns
  pages.push({ pageType: "avoidance_patterns", content: buildAvoidancePatterns(typedEvents) });

  // 4. Recent week
  pages.push({ pageType: "recent_week", content: buildRecentWeek(typedEvents, reminders) });

  // 5. Tasks summary (Issue 12 fix)
  const tasksContent = buildTasksSummary(tasks);
  if (tasksContent) pages.push({ pageType: "tasks_summary", content: tasksContent });

  await Promise.all(
    pages.map((p) =>
      client.mutation(api.userWiki.upsertPage, {
        userId,
        pageType: p.pageType,
        content: p.content,
      })
    )
  );

  return { pagesWritten: pages.length };
}
