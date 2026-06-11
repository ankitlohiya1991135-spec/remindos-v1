import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";
import { syncUserWiki } from "../../../../lib/server/wiki-sync";
import { type LifeDomain, type ReminderItem, type TaskItem } from "@repo/reminder";

// ─── Gap 8: profile-based time suggestion ─────────────────────────────────────

export function computeDomainHourPatterns(events: Array<Record<string, unknown>>): Record<string, number> {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const e of events) {
    const domain = typeof e.domain === "string" ? e.domain : undefined;
    const ts = Number(e.createdAt);
    if (!domain || !Number.isFinite(ts)) continue;
    const hour = new Date(ts).getHours();
    sums[domain] = (sums[domain] ?? 0) + hour;
    counts[domain] = (counts[domain] ?? 0) + 1;
  }
  const result: Record<string, number> = {};
  for (const [d, sum] of Object.entries(sums)) result[d] = sum / counts[d]!;
  return result;
}

export function inferDomainFromTitle(title: string): LifeDomain | undefined {
  const t = title.toLowerCase();
  if (/\b(medicine|pill|doctor|health|gym|workout|run|yoga|exercise|appointment|dentist|hospital)\b/.test(t)) return "health";
  if (/\b(pay|bill|bank|budget|invest|tax|salary|finance|money|loan|insurance)\b/.test(t)) return "finance";
  if (/\b(meeting|work|boss|client|project|deadline|review|presentation|interview|standup|sprint|office)\b/.test(t)) return "career";
  if (/\b(hobby|craft|paint|guitar|book|read|learn|course|class|practice)\b/.test(t)) return "hobby";
  if (/\b(movie|party|dinner|game|concert|friend|fun|hangout|travel|trip)\b/.test(t)) return "fun";
  return undefined;
}

export function suggestDomainTime(
  domain: LifeDomain | undefined,
  title: string,
  profile: { preferredWorkingHoursStart?: number; preferredWorkingHoursEnd?: number } | null,
  domainHourPatterns: Record<string, number>,
): { hour: number; minute: number; basis: string } {
  const effectiveDomain = domain ?? inferDomainFromTitle(title);
  // 1. Event-based average hour for this domain
  if (effectiveDomain && domainHourPatterns[effectiveDomain] != null) {
    const avg = Math.round(domainHourPatterns[effectiveDomain]!);
    const h = Math.min(Math.max(avg, 7), 22);
    return { hour: h, minute: 0, basis: `your ${effectiveDomain} reminder patterns` };
  }
  // 2. Profile working hours
  const ws = profile?.preferredWorkingHoursStart;
  if (ws != null && Number.isFinite(ws) && ws >= 6 && ws <= 22) {
    return { hour: ws, minute: 0, basis: "your preferred working hours" };
  }
  // 3. Domain keyword defaults
  const defaults: Record<string, { hour: number; minute: number }> = {
    health: { hour: 8, minute: 0 },
    finance: { hour: 10, minute: 0 },
    career: { hour: 9, minute: 0 },
    hobby: { hour: 18, minute: 0 },
    fun: { hour: 19, minute: 0 },
  };
  if (effectiveDomain && defaults[effectiveDomain]) {
    return { ...defaults[effectiveDomain]!, basis: `typical ${effectiveDomain} schedule` };
  }
  // 4. Title keyword hints
  const t = title.toLowerCase();
  if (/\b(medicine|pill|workout|gym|run|yoga)\b/.test(t)) return { hour: 8, minute: 0, basis: "your morning routine" };
  if (/\b(lunch)\b/.test(t)) return { hour: 12, minute: 30, basis: "lunchtime" };
  if (/\b(dinner|movie|concert|party)\b/.test(t)) return { hour: 19, minute: 0, basis: "evening schedule" };
  if (/\b(meeting|standup|call|review)\b/.test(t)) return { hour: 10, minute: 0, basis: "work hours" };
  // 5. Generic default
  return { hour: 9, minute: 0, basis: "a standard morning time" };
}

export async function loadProfileForSuggestion(userId: string): Promise<{
  profile: { preferredWorkingHoursStart?: number; preferredWorkingHoursEnd?: number } | null;
  domainHourPatterns: Record<string, number>;
}> {
  try {
    const client = getConvexClient();
    const [events, profile] = await Promise.all([
      client.query(api.userEvents.getRecent, { userId, limitDays: 30 }),
      client.query(api.userProfiles.get, { userId }),
    ]);
    return {
      profile: profile as { preferredWorkingHoursStart?: number; preferredWorkingHoursEnd?: number } | null,
      domainHourPatterns: computeDomainHourPatterns(events as Array<Record<string, unknown>>),
    };
  } catch {
    return { profile: null, domainHourPatterns: {} };
  }
}

// ─── DB mappers ───────────────────────────────────────────────────────────────

export const LIFE_DOMAINS = new Set(["health", "finance", "career", "hobby", "fun"]);

export function parseLifeDomain(value: unknown): LifeDomain | undefined {
  return typeof value === "string" && LIFE_DOMAINS.has(value) ? (value as LifeDomain) : undefined;
}

export function fromDbReminder(item: Record<string, unknown>): ReminderItem {
  const dueAtMs = Number(item.dueAt ?? Date.now());
  const createdAtMs = Number(item.createdAt ?? Date.now());
  const updatedAtMs = Number(item.updatedAt ?? Date.now());
  return {
    id: String(item._id ?? item.id ?? crypto.randomUUID()),
    title: String(item.title ?? ""),
    dueAt: new Date(dueAtMs).toISOString(),
    recurrence:
      item.recurrence === "daily" || item.recurrence === "weekly" || item.recurrence === "monthly"
        ? item.recurrence : "none",
    notes: typeof item.notes === "string" ? item.notes : "",
    priority: typeof item.priority === "number" ? item.priority : undefined,
    urgency: typeof item.urgency === "number" ? item.urgency : undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : undefined,
    status: item.status === "done" || item.status === "archived" ? item.status : "pending",
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    linkedTaskId: typeof item.linkedTaskId === "string" ? item.linkedTaskId : undefined,
    domain: parseLifeDomain(item.domain),
  };
}

export function fromDbTask(item: Record<string, unknown>): TaskItem {
  const createdAtMs = Number(item.createdAt ?? Date.now());
  const updatedAtMs = Number(item.updatedAt ?? Date.now());
  const dueRaw = item.dueAt;
  return {
    id: String(item._id ?? item.id ?? crypto.randomUUID()),
    title: String(item.title ?? ""),
    notes: typeof item.notes === "string" ? item.notes : undefined,
    dueAt: dueRaw != null && Number.isFinite(Number(dueRaw)) ? new Date(Number(dueRaw)).toISOString() : undefined,
    status: item.status === "done" ? "done" : "pending",
    priority: typeof item.priority === "number" ? item.priority : undefined,
    domain: parseLifeDomain(item.domain),
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

// ─── Data loading ─────────────────────────────────────────────────────────────

export async function loadRemindersForChat(userId: string, fallback: ReminderItem[]): Promise<ReminderItem[]> {
  try {
    const client = getConvexClient();
    // Bug 1+6 fix: use listForChat which fetches only pending + last-7-days-done
    // via the by_user_status_dueAt index — avoids full table scans and ensures
    // a just-marked-done reminder no longer appears as pending.
    const raw = await client.query(api.reminders.listForChat, { userId });
    const seen = new Set<string>();
    const dbReminders = [...raw.owned, ...raw.shared]
      .filter((item) => {
        const id = String(item._id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    return dbReminders.map((item) => fromDbReminder(item));
  } catch {
    return fallback;
  }
}

export async function loadTasksForChat(userId: string, fallback: TaskItem[]): Promise<TaskItem[]> {
  try {
    const client = getConvexClient();
    const rows = await client.query(api.tasks.listForUser, { userId });
    return rows.map((item) => fromDbTask(item as Record<string, unknown>));
  } catch {
    return fallback;
  }
}

/**
 * Load all user wiki pages from Convex.
 * Returns a formatted multi-page string ready to inject into the LLM prompt.
 * If wiki is empty or stale (oldest page > WIKI_STALE_MS), triggers a background
 * rebuild via /api/wiki/sync so the next chat turn benefits from fresh pages.
 *
 * Falls back to "" on any error — never blocks the chat response.
 */
export const WIKI_STALE_MS = 60 * 60 * 1000; // 1 hour

export async function loadUserWiki(userId: string): Promise<string> {
  try {
    const client = getConvexClient();
    const [wikiMap, oldestUpdatedAt] = await Promise.all([
      client.query(api.userWiki.getAll, { userId }),
      client.query(api.userWiki.getOldestUpdatedAt, { userId }),
    ]);

    const pages = wikiMap as Record<string, { content: string; updatedAt: number }>;
    const pageCount = Object.keys(pages).length;

    // If wiki is empty or stale, trigger a background rebuild (direct call, fire-and-forget)
    const isStale = oldestUpdatedAt === 0 || Date.now() - oldestUpdatedAt > WIKI_STALE_MS;
    if (isStale) {
      syncUserWiki(userId).catch(() => {});
      // If no pages exist yet, return empty so this turn isn't blocked
      if (pageCount === 0) return "";
    }

    // Assemble pages in priority order: recent_week first (most current),
    // then behavior_summary, then tasks_summary (same behavioral tier),
    // then domains, then avoidance.
    const ORDER = [
      "recent_week",
      "behavior_summary",
      "tasks_summary",
      "domain_health",
      "domain_finance",
      "domain_career",
      "domain_hobby",
      "domain_fun",
      "avoidance_patterns",
    ];

    const parts: string[] = [];
    for (const key of ORDER) {
      if (pages[key]?.content) parts.push(pages[key]!.content);
    }
    // Any extra pages not in the order list
    for (const [key, val] of Object.entries(pages)) {
      if (!ORDER.includes(key) && val.content) parts.push(val.content);
    }

    if (parts.length === 0) return "";
    return `--- USER KNOWLEDGE WIKI ---\n${parts.join("\n\n")}`;
  } catch {
    return "";
  }
}

// FLAW-5: limit reminders sent to LLM — pending only, most relevant first.
// Cap overdue at 30 and future at 30 so a large backlog never drowns out
// upcoming reminders that the user just created or wants to reschedule.
export function filterRemindersForLLM(reminders: ReminderItem[]): ReminderItem[] {
  const now = Date.now();
  const pending = reminders.filter((r) => r.status === "pending");
  const overdue = pending
    .filter((r) => new Date(r.dueAt).getTime() < now)
    .sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime()) // most-recent overdue first
    .slice(0, 30);
  const future = pending
    .filter((r) => new Date(r.dueAt).getTime() >= now)
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()) // soonest first
    .slice(0, 30);
  // Include recently completed for context (last 7 days)
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentDone = reminders
    .filter((r) => r.status === "done" && new Date(r.updatedAt).getTime() > weekAgo)
    .slice(0, 5);
  return [...overdue, ...future, ...recentDone];
}

// MISSING-2/3: load behavioral profile + events for the digest
export async function buildBehaviorContext(userId: string): Promise<string> {
  try {
    const client = getConvexClient();
    const [events, profile] = await Promise.all([
      client.query(api.userEvents.getRecent, { userId, limitDays: 30 }),
      client.query(api.userProfiles.get, { userId }),
    ]);

    const lines: string[] = ["--- BEHAVIORAL PROFILE ---"];
    const completions = (events as Array<Record<string, unknown>>).filter((e) => e.eventType === "reminder_completed");
    const creations = (events as Array<Record<string, unknown>>).filter((e) => e.eventType === "reminder_created");
    const taskDone = (events as Array<Record<string, unknown>>).filter((e) => e.eventType === "task_completed");

    lines.push(`Last 30 days: ${creations.length} reminders created, ${completions.length} completed, ${taskDone.length} tasks completed.`);

    if (creations.length > 0) {
      const rate = Math.round((completions.length / creations.length) * 100);
      lines.push(`Reminder completion rate: ${rate}%.`);
    }

    const domainCounts: Record<string, number> = {};
    for (const e of completions) {
      const d = e.domain as string | undefined;
      if (d) domainCounts[d] = (domainCounts[d] ?? 0) + 1;
    }
    const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0];
    if (topDomain) lines.push(`Most completed domain: ${topDomain[0]} (${topDomain[1]} items).`);

    const p = profile as Record<string, unknown> | null;
    if (p?.preferredWorkingHoursStart != null && p?.preferredWorkingHoursEnd != null) {
      lines.push(`Preferred working hours: ${p.preferredWorkingHoursStart}:00–${p.preferredWorkingHoursEnd}:00.`);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

// M1 fix: messages are persisted client-side via /api/chat/history (flushChatHistoryToServer).
// Saving here too created duplicate records in Convex (different clientId per path → two rows per message).
// The function is kept as a no-op so all 73 call sites compile without change.
export function saveMessageServerSide(
  _userId: string,
  _role: "user" | "assistant",
  _content: string,
): Promise<void> {
  return Promise.resolve();
}

export function looksLikeConfirmation(message: string): boolean {
  const n = message.toLowerCase().trim();
  return /^(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|do it|proceed|correct|right|absolutely|definitely|sounds good|alright|all right|fine|please do it|please do|please proceed|that's right|that is right|affirmative|exactly|perfect|great|sure thing|of course|please|done|let's do it|lets do it)[\s!.,]*$/.test(n);
}

export function findTargetReminder(reminders: ReminderItem[], targetId?: string, targetTitle?: string): ReminderItem | undefined {
  if (targetId) {
    const byId = reminders.find((r) => r.id === targetId);
    if (byId) return byId;
  }
  if (targetTitle) {
    const t = targetTitle.toLowerCase();
    // Exact title match wins — prevents a shorter title that is a prefix of a
    // longer one (e.g. "Hupendra work" vs "Hupendra work share project link")
    // from being grabbed arbitrarily by the first substring hit.
    const exact = reminders.find((r) => r.title.toLowerCase() === t);
    if (exact) return exact;
    // Prefer a UNIQUE substring match; if the fragment matches several titles,
    // pick the closest by length so the most-specific reminder wins rather than
    // whichever happens to be first in the array.
    const subMatches = reminders.filter((r) => r.title.toLowerCase().includes(t));
    if (subMatches.length === 1) return subMatches[0];
    if (subMatches.length > 1) {
      return [...subMatches].sort(
        (a, b) => Math.abs(a.title.length - t.length) - Math.abs(b.title.length - t.length),
      )[0];
    }
  }
  return undefined;
}

export function normalizeClientTimeZone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.length < 2 || t.length > 120) return undefined;
  return t;
}

