/**
 * dashboard-utils.ts
 *
 * Pure utility functions, constants, and static data for the dashboard.
 * No React imports — all functions here are framework-agnostic and safe
 * to import from any component or server module.
 */

import {
  getReminderBucket,
  type BriefingSection,
  type ReminderItem,
  type TaskItemBrief,
} from "@repo/reminder";
import type { ReplyContextPayload } from "../../lib/chat-reply-context";
import type { WalkthroughStep } from "./walkthrough-overlay";
import type {
  ChatMessage,
  ChatRole,
  DirectoryUser,
  ShareInboxRow,
} from "./dashboard-types";
import type { LifeDomain } from "@repo/reminder";
import type { TaskRow } from "./task-panels";

// ─── Constants ─────────────────────────────────────────────────────────────

export const SHOW_SUGGESTED_QUESTIONS_KEY = "remindos:showSuggestedQuestions";
export const DEFAULT_CHAT_REMINDER_TITLE = "Reminder";
export const CHAT_THREAD_BACKUP_PREFIX = "remindos:chatThread:";
export const WALKTHROUGH_RELEASE_AT = Date.parse("2026-04-20T00:00:00.000Z");
export const WALKTHROUGH_STORAGE_PREFIX = "remindos:walkthrough-completed:";
export const DUE_SHOWN_KEY = "remindos:dueShown";
export const LIFE_DOMAINS = new Set<string>([
  "health",
  "finance",
  "career",
  "hobby",
  "fun",
]);

export function parseLifeDomain(value: unknown): LifeDomain | undefined {
  return typeof value === "string" && LIFE_DOMAINS.has(value)
    ? (value as LifeDomain)
    : undefined;
}

export const STARTER_MESSAGE: ChatMessage = {
  id: "starter",
  role: "assistant",
  content:
    "Hi! Ask me anything about your reminders—what's next, times, notes, or compare your day. I can also create or complete them. Example: 'Create reminder tomorrow at 9am for gym'.",
  createdAt: new Date().toISOString(),
  meta: {
    skipPersist: true,
  },
};

export const loadingTexts = [
  "Processing your message...",
  "Understanding your reminder intent...",
  "Preparing the best response for you...",
  "Almost there, finalizing your reminder assistant reply...",
];

export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    id: "all-tasks",
    line1: "This is All tasks.",
    line2: "Open it to view, edit, and track all tasks quickly.",
    targetSelectors: [
      '[data-walkthrough="all-tasks-trigger"]',
      '[aria-label="All tasks"]',
    ],
    nextLabel: "Next",
  },
  {
    id: "briefing",
    line1: "This is Briefing.",
    line2: "Tap it for a quick summary of what needs attention now.",
    targetSelectors: [
      '[data-walkthrough="briefing-trigger"]',
      '[aria-label="Run briefing"]',
    ],
    nextLabel: "Next",
  },
  {
    id: "create-reminder",
    line1: "This is Create reminder.",
    line2: "Add a reminder in seconds with date, priority, and notes.",
    targetSelectors: [
      '[data-walkthrough="create-reminder-trigger"]',
      '[data-testid="chat-mobile-create-reminder"]',
      '[aria-label="Create reminder"]',
    ],
    nextLabel: "Next",
  },
  {
    id: "menu",
    line1: "This is your workspace menu.",
    line2: "Use it to open snapshot and other quick actions.",
    targetSelectors: [
      '[data-walkthrough="snapshot-trigger"]',
      '[aria-label="Open workspace menu"]',
    ],
    nextLabel: "Finish",
  },
];

// ─── Storage helpers ────────────────────────────────────────────────────────

export function walkthroughStorageKey(userId: string): string {
  return `${WALKTHROUGH_STORAGE_PREFIX}${userId}`;
}

export function chatThreadBackupKey(userId: string): string {
  return `${CHAT_THREAD_BACKUP_PREFIX}${userId}`;
}

export function loadChatBackup(userId: string): ChatMessage[] | null {
  if (typeof localStorage === "undefined" || !userId) return null;
  try {
    const raw = localStorage.getItem(chatThreadBackupKey(userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data) || data.length === 0) return null;
    const out: ChatMessage[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : null;
      const role = m.role;
      const content = typeof m.content === "string" ? m.content : "";
      const createdAt = typeof m.createdAt === "string" ? m.createdAt : null;
      if (!id || !createdAt) continue;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      if (!content.trim()) continue;
      out.push({
        id,
        role,
        content,
        createdAt,
        meta: m.meta as ChatMessage["meta"],
      });
    }
    return out.length > 0 ? dedupeMessagesById(out) : null;
  } catch {
    return null;
  }
}

export function saveChatBackup(userId: string, messages: ChatMessage[]): void {
  if (typeof localStorage === "undefined" || !userId) return;
  try {
    const persistable = dedupeMessagesById(messages).filter(
      (m) => !m.meta?.skipPersist,
    );
    if (persistable.length === 0) {
      localStorage.removeItem(chatThreadBackupKey(userId));
      return;
    }
    const capped = persistable.slice(-400);
    localStorage.setItem(chatThreadBackupKey(userId), JSON.stringify(capped));
  } catch {
    /* quota or private mode */
  }
}

export function clearChatBackup(userId: string): void {
  if (typeof localStorage === "undefined" || !userId) return;
  try {
    localStorage.removeItem(chatThreadBackupKey(userId));
  } catch {
    /* ignore */
  }
}

export function readDueShown(): Set<string> {
  if (typeof sessionStorage === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(DUE_SHOWN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function markDueShown(key: string): void {
  if (typeof sessionStorage === "undefined") return;
  const next = readDueShown();
  next.add(key);
  sessionStorage.setItem(DUE_SHOWN_KEY, JSON.stringify([...next]));
}

// ─── Chat message helpers ───────────────────────────────────────────────────

export function dedupeMessagesById(messages: ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (!message?.id) continue;
    map.set(message.id, message);
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export function mergeRemoteChat(
  local: ChatMessage[],
  remote: ChatMessage[],
): ChatMessage[] {
  if (remote.length === 0) return local;
  const localBase = local.filter((m) => m.id !== "starter");
  const remoteMap = new Map(remote.map((m) => [m.id, m]));
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const m of localBase) {
    if (m.meta?.skipPersist) {
      out.push(m);
      seen.add(m.id);
      continue;
    }
    const r = remoteMap.get(m.id);
    out.push(r ?? m);
    seen.add(m.id);
  }
  for (const m of remote) {
    if (!seen.has(m.id)) {
      out.push(m);
      seen.add(m.id);
    }
  }
  return dedupeMessagesById(out);
}

export function toReplyContextPayload(
  target: ChatMessage | null | undefined,
): ReplyContextPayload | undefined {
  if (!target?.content?.trim()) return undefined;
  return {
    id: target.id,
    content: target.content,
    role: target.role === "system" ? "system" : target.role,
  };
}

export function chatReplyLabel(role: ChatRole): string {
  if (role === "user") return "You";
  if (role === "assistant") return "RemindOS";
  return "Notice";
}

export function briefingSectionLabel(
  section: BriefingSection | undefined,
): string {
  switch (section) {
    case "greeting":    return "Briefing";
    case "completed":   return "Completed";
    case "overdue":     return "Overdue";
    case "today":       return "Today";
    case "tomorrow":    return "Tomorrow";
    case "later":       return "Coming up";
    case "tasks":       return "Tasks by priority";
    case "closing":     return "Next step";
    default:            return "Session briefing";
  }
}

// ─── Timezone ───────────────────────────────────────────────────────────────

/** Ensures server-side chat uses the same IANA zone as the browser (fixes UTC vs local due times). */
export function clientTimeZonePayload(): { timeZone?: string } {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz ? { timeZone: tz } : {};
  } catch {
    return {};
  }
}

// ─── Date / time display ────────────────────────────────────────────────────

export function formatSummaryTime(value: string): string {
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export function formatDisplayDateTime(value: string | number): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}

export function toDateTimeLocalValue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function currentDateTimeLocalValue(): string {
  return toDateTimeLocalValue(new Date().toISOString());
}

// ─── Reminder helpers ───────────────────────────────────────────────────────

export function fromApiReminder(item: Record<string, unknown>): ReminderItem {
  const access = item._access === "shared" ? "shared" : "owner";
  const p = item.priority;
  const linked = item.linkedTaskId;
  const ownerUserId =
    access === "shared" && typeof item.userId === "string"
      ? item.userId
      : undefined;
  const shareRecipients = Array.isArray(item._shareRecipients)
    ? (item._shareRecipients as { userId: string; displayName: string }[])
    : undefined;
  const outgoingShared = item._outgoingShared === true;
  return {
    id: String(item._id ?? item.id ?? crypto.randomUUID()),
    title: String(item.title ?? ""),
    dueAt: new Date(Number(item.dueAt ?? Date.now())).toISOString(),
    notes: typeof item.notes === "string" ? item.notes : "",
    recurrence:
      item.recurrence === "daily" ||
      item.recurrence === "weekly" ||
      item.recurrence === "monthly"
        ? item.recurrence
        : "none",
    status:
      item.status === "done" || item.status === "archived"
        ? item.status
        : "pending",
    priority: typeof p === "number" && Number.isFinite(p) ? p : undefined,
    createdAt: new Date(Number(item.createdAt ?? Date.now())).toISOString(),
    updatedAt: new Date(Number(item.updatedAt ?? Date.now())).toISOString(),
    access,
    ownerUserId,
    shareRecipients: access === "owner" ? shareRecipients : undefined,
    outgoingShared: access === "owner" ? outgoingShared : undefined,
    linkedTaskId: typeof linked === "string" ? linked : undefined,
    domain: parseLifeDomain(item.domain),
  };
}

export function matchesReminder(
  reminder: ReminderItem,
  targetId?: string,
  targetTitle?: string,
): boolean {
  if (targetId && reminder.id === targetId) return true;
  if (!targetTitle) return false;
  return reminder.title.toLowerCase().includes(targetTitle.toLowerCase());
}

export function dueMinuteKey(reminder: ReminderItem): string {
  const d = new Date(reminder.dueAt);
  return `${reminder.id}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

export function isDueThisMinute(dueAtIso: string, now: Date): boolean {
  const d = new Date(dueAtIso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate() &&
    d.getHours() === now.getHours() &&
    d.getMinutes() === now.getMinutes()
  );
}

export function isNextTwoHoursReminder(
  reminder: ReminderItem,
  now = new Date(),
): boolean {
  if (reminder.status === "done" || reminder.status === "archived") return false;
  const dueMs = new Date(reminder.dueAt).getTime();
  if (!Number.isFinite(dueMs)) return false;
  const nextTwoHoursMs = now.getTime() + 2 * 60 * 60 * 1000;
  return dueMs >= now.getTime() && dueMs < nextTwoHoursMs;
}

export function reminderStateLabel(
  reminder: ReminderItem,
  now = new Date(),
): string {
  if (reminder.status === "done" || reminder.status === "archived") return "Done";
  if (getReminderBucket(reminder, now) === "missed") return "Missed";
  return "Upcoming";
}

export function buildOpeningSummaryMessage(input: {
  reminders: ReminderItem[];
  tasks: TaskItemBrief[];
  firstName?: string | null;
  now?: Date;
}): ChatMessage {
  const now = input.now ?? new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const next2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const overdueToday: ReminderItem[] = [];
  const nextTwoHours: ReminderItem[] = [];
  const upcomingLater: ReminderItem[] = [];

  for (const reminder of input.reminders) {
    if (reminder.status === "done" || reminder.status === "archived") continue;
    const dueMs = new Date(reminder.dueAt).getTime();
    if (!Number.isFinite(dueMs)) continue;

    if (dueMs >= startToday.getTime() && dueMs < now.getTime()) {
      overdueToday.push(reminder);
      continue;
    }
    if (dueMs >= now.getTime() && dueMs < next2h.getTime()) {
      nextTwoHours.push(reminder);
      continue;
    }
    if (dueMs >= next2h.getTime()) {
      upcomingLater.push(reminder);
    }
  }

  overdueToday.sort(
    (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
  );
  nextTwoHours.sort(
    (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
  );
  upcomingLater.sort(
    (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
  );

  const name = input.firstName?.trim();
  const lines = [
    name
      ? `Good ${now.getHours() < 12 ? "morning" : now.getHours() < 18 ? "afternoon" : "evening"}, ${name}.`
      : "Here is your reminder overview:",
    "",
    `### 1) Today's overdue reminders (${overdueToday.length})`,
  ];

  if (overdueToday.length === 0) {
    lines.push("- None");
  } else {
    for (const item of overdueToday) {
      lines.push(`- ${formatSummaryTime(item.dueAt)} — **${item.title}**`);
    }
  }

  lines.push("", `### 2) Next 2 hours reminders (${nextTwoHours.length})`);
  if (nextTwoHours.length === 0) {
    lines.push("- None");
  } else {
    for (const item of nextTwoHours) {
      lines.push(`- ${formatSummaryTime(item.dueAt)} — **${item.title}**`);
    }
  }

  lines.push(
    "",
    `### 3) Remaining upcoming reminders (${upcomingLater.length})`,
  );
  if (upcomingLater.length === 0) {
    lines.push("- None");
  } else {
    for (const item of upcomingLater.slice(0, 12)) {
      lines.push(
        `- ${new Date(item.dueAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })} ${formatSummaryTime(item.dueAt)} — **${item.title}**`,
      );
    }
  }

  return {
    id: `opening-summary-${Date.now()}`,
    role: "assistant",
    content: lines.join("\n"),
    createdAt: now.toISOString(),
    meta: {
      kind: "opening_summary",
      skipPersist: true,
    },
  };
}

// ─── Task helpers ───────────────────────────────────────────────────────────

export function fromApiTask(row: Record<string, unknown>): TaskRow {
  const pr = row.priority;
  return {
    id: String(row._id ?? row.id ?? crypto.randomUUID()),
    title: String(row.title ?? ""),
    notes: typeof row.notes === "string" ? row.notes : undefined,
    dueAt:
      row.dueAt != null
        ? new Date(Number(row.dueAt)).toISOString()
        : undefined,
    status: row.status === "done" ? "done" : "pending",
    priority:
      typeof pr === "number" && Number.isFinite(pr) ? pr : undefined,
    domain: parseLifeDomain(row.domain),
  };
}

export function taskBucket(
  task: TaskRow,
  now: Date,
): "missed" | "later" | "done" {
  if (task.status === "done") return "done";
  if (task.dueAt && new Date(task.dueAt).getTime() < now.getTime())
    return "missed";
  return "later";
}

// ─── Directory / sharing helpers ───────────────────────────────────────────

export function groupShareInboxRows(
  rows: ShareInboxRow[],
): { batchKey: string; rows: ShareInboxRow[] }[] {
  const map = new Map<string, ShareInboxRow[]>();
  for (const row of rows) {
    const key = row.shareBatchId ?? `legacy:${row._id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return [...map.entries()].map(([batchKey, list]) => ({
    batchKey,
    rows: list,
  }));
}

export function directoryDisplayName(u: DirectoryUser): string {
  const n = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (n) return n;
  if (u.username) return `@${u.username}`;
  return u.email || "User";
}

// ─── Invite token extraction ────────────────────────────────────────────────

export function extractInviteToken(text: string): string | null {
  const trimmed = text.trim();
  const fromUrl = trimmed.match(/[?&]invite=([^&\s#]+)/i);
  if (fromUrl?.[1]) return decodeURIComponent(fromUrl[1]);
  const acceptHex = trimmed.match(/\baccept\s+invite\s+([a-f\d]{16,64})\b/i);
  if (acceptHex?.[1]) return acceptHex[1];
  const plainHex = trimmed.match(/\b([a-f\d]{24,40})\b/i);
  if (
    plainHex?.[1] &&
    /\b(accept|invite|join)\b/i.test(trimmed)
  )
    return plainHex[1];
  return null;
}

// ─── Chat input parsing helpers ─────────────────────────────────────────────

/** Strip "create reminder for …" prefix from raw user input. */
export function extractCreateTitle(value: string): string {
  return value
    .replace(/^\s*create(\s+a)?\s+reminder\s*/i, "")
    .replace(/^\s*(for|about)\s+/i, "")
    .trim();
}

/** Return true if the message already contains a date/time hint. */
export function hasInlineCreateDetails(value: string): boolean {
  return (
    /\b(today|tomorrow|tmrw|tomorow|tommarow|day after tomorrow|after tomorrow|आज|कल|उद्या|परसों|परवा|noon|midnight)\b/i.test(value) ||
    /\b\d{1,2}(?:[:.]\d{2})?\s*(am|pm)\b/i.test(value) ||
    /\b\d{1,2}[:.]\d{2}\b/.test(value)
  );
}

/** Parse a fuzzy date string ("today", "tomorrow", "2025-06-01", etc.) into ISO date. */
export function parseDateInput(value: string, now: Date): string | null {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (/^(today|आज)$/.test(text)) return base.toISOString().slice(0, 10);
  if (/^(tomorrow|tmrw|tomorow|tommarow|कल|उद्या)$/.test(text)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^(day after tomorrow|after tomorrow|परसों|परवा)$/.test(text)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const parsed = new Date(y, mo - 1, d);
  if (
    parsed.getFullYear() !== y ||
    parsed.getMonth() !== mo - 1 ||
    parsed.getDate() !== d
  ) {
    return null;
  }
  return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/** Parse a fuzzy time string ("3pm", "14:30", "noon", etc.) into "HH:MM". */
export function parseTimeInput(value: string): string | null {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/\b([ap])\.\s?m\.\b/g, "$1m");
  if (text === "noon") return "12:00";
  if (text === "midnight") return "00:00";
  if (/^(दोपहर|दुपारी)$/.test(text)) return "12:00";
  if (/^(आधी रात|मध्यरात्र)$/.test(text)) return "00:00";

  const meridiem = text.match(/\b(\d{1,2})(?:[:.]\s*(\d{2}))?\s?(am|pm)\b/i);
  if (meridiem) {
    const hourRaw = Number(meridiem[1] ?? "0");
    const minute = Number(meridiem[2] ?? "0");
    if (!Number.isFinite(hourRaw) || hourRaw < 1 || hourRaw > 12) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    let hour = hourRaw % 12;
    if ((meridiem[3] ?? "am").toLowerCase() === "pm") hour += 12;
    return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  }

  const clock = text.match(/^\s*(\d{1,2})[:.]\s*(\d{2})\s*$/);
  if (clock) {
    const hour = Number(clock[1] ?? "-1");
    const minute = Number(clock[2] ?? "-1");
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  }

  const regional = text.match(
    /^\s*(\d{1,2})(?:[:.]\s*(\d{2}))?\s*(?:बजे|वाजता|वाजले)?\s*(सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात)?\s*$/,
  );
  if (!regional) return null;
  const rawHour = Number(regional[1] ?? "-1");
  const minute = Number(regional[2] ?? "0");
  if (rawHour < 0 || rawHour > 23 || minute < 0 || minute > 59) return null;
  const part = (regional[3] ?? "").toLowerCase();
  if (!part && !/(?:बजे|वाजता|वाजले)/i.test(text)) return null;

  let hour = rawHour;
  if (/सुबह|सकाळी/i.test(part)) {
    if (hour === 12) hour = 0;
  } else if (/दोपहर|दुपारी|शाम|सायंकाळी|रात/i.test(part)) {
    if (hour >= 1 && hour <= 11) hour += 12;
  }
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}
