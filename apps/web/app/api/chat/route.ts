import { auth } from "@clerk/nextjs/server";
import {
  analyzeSchedule,
  buildLifeOsContextBlock,
  buildListRemindersReply,
  classifyReminderIntent,
  filterToday,
  findReminderByFuzzyMatch,
  inferListScopeFromMessage,
  isCompoundReminderQuestion,
  looksLikeCreateIntent,
  looksLikeMarkDoneIntent,
  looksLikeDeleteIntent,
  looksLikeBulkIntent,
  looksLikeSnoozeIntent,
  looksLikeEditIntent,
  looksLikeRescheduleIntent,
  getReminderBucket,
  filterRemindersByListScope,
  describeReminderForChat,
  rankTasks,
  tryGroundedReminderAnswer,
  type ReminderListScope,
  type LifeDomain,
  type ReminderItem,
  type TaskItem,
} from "@repo/reminder";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient } from "../../../lib/server/convex-client";
import {
  buildMessageWithReplyContext,
  type ReplyContextPayload,
} from "../../../lib/chat-reply-context";
import { getChatHistory } from "../../../lib/server/chat-history";
import { syncUserWiki } from "../../../lib/server/wiki-sync";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReminderAgentActionType =
  | "create_reminder"
  | "list_reminders"
  | "mark_done"
  | "delete_reminder"
  | "reschedule_reminder"
  | "snooze_reminder"
  | "edit_reminder"
  | "bulk_action"
  | "clarify"
  | "pending_confirm"
  | "unknown";

interface ReminderAgentAction {
  type: ReminderAgentActionType;
  title?: string;
  dueAt?: string;
  notes?: string;
  priority?: number;
  domain?: LifeDomain;
  recurrence?: "none" | "daily" | "weekly" | "monthly";
  linkedTaskId?: string;
  targetTitle?: string;
  targetId?: string;
  scope?: "today" | "tomorrow" | "missed" | "done" | "pending" | "all" | "later" | "future";
  /** Only on pending_confirm: the action waiting for user confirmation */
  pendingType?: "mark_done" | "delete_reminder" | "edit_reminder";
  /** Only on snooze_reminder: minutes to push the due time forward */
  delayMinutes?: number;
  /** Only on edit_reminder: new title or new notes value */
  newTitle?: string;
  newNotes?: string;
  /** Only on bulk_action / pending_confirm(bulk): operation and resolved IDs */
  bulkOperation?: "mark_done" | "delete";
  bulkTargetIds?: string[];
  /** Only on list_reminders: ordered IDs of what was shown, for multi-turn ordinal resolution */
  listedIds?: string[];
  /** Only on clarify (no-time create): suggested dueAt ISO from profile/domain analysis */
  suggestedDueAt?: string;
  /** Only on clarify (disambiguation): pending operation type so the client doesn't start the create wizard */
  pendingOp?: "mark_done" | "delete";
  /** Only on clarify (disambiguation): IDs of ambiguous reminder candidates */
  candidateIds?: string[];
}

interface ReminderAgentResponse {
  reply: string;
  action: ReminderAgentAction;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "mistralai/mistral-medium-3.5-128b";
const DEFAULT_CHAT_REMINDER_TITLE = "Reminder";
const MAX_HISTORY_TURNS = 20; // last 10 user/assistant pairs — Issue 5 fix

// ─── FLAW-3: simple per-user rate limiter (20 req/min) ───────────────────────
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 20;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const systemPrompt = `You are the RemindOS assistant for Personal Life OS. You help with the user's reminders and tasks (orchestration layer).

CONTEXT SOURCES (use all of them — they are complementary, not competing):
1. USER KNOWLEDGE WIKI — persistent profile about this user: their habits, completion patterns, avoidance patterns, domain strengths/weaknesses, and recent activity. Read this FIRST to understand who you are talking to before answering.
2. LIFE OS DIGEST — the live list of current pending and recent reminders + tasks. Use for precise CRUD actions (titles, IDs, times).
3. LIFE OS JSON — machine-readable version of the digest for exact field values.

DATA RULES (critical):
- Do not invent, rename, or assume reminder/task items. All items must come from the DIGEST or JSON.
- The WIKI is authoritative for behavioral patterns and history. The DIGEST is authoritative for current item state.
- Reminders may link to a task (see task id / task title in digest). If a reminder has no linked task, it is labeled ADHOC (standalone).
- Optional domain tags (health, finance, career, hobby, fun) may appear on reminders and tasks.
- If the answer is not in any of the context sources, say you do not see that in their data.
- Never paste raw ISO-8601 timestamps in "reply". Use natural language dates/times. The digest lists due times in the user's time zone — quote them exactly as shown.
- Overdue items show how long they have been overdue (e.g. "overdue 3d") — use this context when advising the user.
- When the user asks behavioral questions ("what do I keep forgetting?", "how am I doing?", "what's my pattern?") — answer from the WIKI, not just the current digest.

WHAT YOU CAN DO:
- Answer questions about reminders and tasks: schedules, conflicts, "what's next", which reminders belong to which task, ADHOC vs task-linked, domains, comparisons, counts, overdue, notes, recurrence.
- Answer behavioral/insight questions using the WIKI: completion rates, avoidance patterns, domain performance, streaks, habits.
- Small talk or unrelated topics: politely redirect to reminders and tasks.

ACTIONS (JSON action.type):
- list_reminders: user wants a simple list or roll-up by period (server may replace reply with a grounded list). Set scope: today|tomorrow|missed|done|pending|all.
- mark_done: user wants to complete one reminder; set targetTitle or targetId from digest.
- delete_reminder: user wants to remove one reminder; set targetTitle or targetId.
- reschedule_reminder: user wants a new time for one reminder; set dueAt as ISO in action only, plus targetTitle/targetId.
- snooze_reminder: user wants to delay a reminder by a duration (e.g. "snooze 30 min", "push back 1 hour"). Set targetTitle/targetId and delayMinutes (integer). The server will handle this fast-path so you rarely need to emit it directly.
- edit_reminder: user wants to change the title or notes of one reminder. Set targetTitle/targetId plus newTitle or newNotes.
- bulk_action: user wants to act on ALL reminders in a scope (e.g. "mark all today's reminders done", "delete all missed"). Set bulkOperation ("mark_done"|"delete") and scope.
- create_reminder: only if user clearly wants to create. May include priority (1-5), domain, recurrence, linkedTaskId.
- clarify: you need exactly one missing piece (which reminder, which time). Ask a single focused question.
- unknown: questions you answer in "reply" only (no database change). Use for explanations, reasoning, comparisons, counts, behavioral insights, and open-ended Q&A.

IMPORTANT RULES FOR ACTIONS:
- snooze and edit are handled by fast-path code; prefer snooze_reminder/edit_reminder action types so the server can resolve them deterministically.
- Never set action.type to "mark_done" or "delete_reminder" for bulk requests; use "bulk_action" instead.
- Only emit one action per response. If the request is ambiguous, emit clarify.

Keep "reply" helpful and concise but include enough detail (titles, times, notes) when relevant.

SPELLING / TYPOS: Users often misspell reminder titles. If a message contains a word that closely resembles a reminder title in the digest (same first letter, similar length, off by 1-2 characters), treat it as that reminder. Match aggressively — better to answer about a probable reminder than to say you don't see it.

QUESTIONS NOT ABOUT REMINDERS: If the user asks a general knowledge question (e.g. "what is dynamic humour") that has nothing to do with their reminders or tasks, politely respond in "reply" that you are a reminders assistant and offer to show their pending reminders. Always use action.type = "unknown".

NEVER-FAIL RULES (very important — these protect product trust):
1. NEVER say "I don't see that", "I can't find that", "not in the provided context", "doesn't mention", "I'm not sure what you mean", or anything similar. These are forbidden phrases.
2. NEVER ask the user to "rephrase" or "try again". The user's message is always valid input.
3. If you genuinely cannot find a matching reminder for a query, instead of refusing: pick the 2-3 most likely candidates from the digest by partial keyword overlap and present them: "Did you mean X, Y, or Z? Here are the closest matches: ...".
4. If even partial matching fails, list the user's top 3 most urgent pending reminders so they have context to refine their question.
5. Always include concrete data (titles, times, counts) in your reply — never reply with only a question or apology.

CRITICAL: You MUST always respond with ONLY the JSON object shown below. Never write plain text, markdown, or explanations outside the JSON. If you are unsure, use action.type = "unknown" and write your answer in "reply".

Output ONLY valid JSON — no text before or after the braces:
{
  "reply":"string — your full response to the user",
  "action":{
    "type":"create_reminder|list_reminders|mark_done|delete_reminder|reschedule_reminder|snooze_reminder|edit_reminder|bulk_action|clarify|unknown",
    "title":"optional – for create",
    "dueAt":"optional ISO string – for create or reschedule",
    "notes":"optional",
    "priority":"optional 1-5",
    "domain":"optional health|finance|career|hobby|fun",
    "recurrence":"optional none|daily|weekly|monthly",
    "linkedTaskId":"optional – for create",
    "targetTitle":"optional – for single-item actions",
    "targetId":"optional – for single-item actions",
    "newTitle":"optional – for edit_reminder",
    "newNotes":"optional – for edit_reminder",
    "delayMinutes":"optional integer – for snooze_reminder",
    "bulkOperation":"optional mark_done|delete – for bulk_action",
    "scope":"optional today|tomorrow|missed|done|pending|all – for list or bulk"
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDueInUserZone(iso: string, timeZone?: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

function mapAgentScopeToListScope(scope?: string): ReminderListScope | null {
  switch (scope) {
    case "today": return "today";
    case "tomorrow": return "tomorrow";
    case "missed": return "missed";
    case "done": return "done";
    case "pending":
    case "all": return "all_pending";
    default: return null;
  }
}

function formatDecisionReply(reminders: ReminderItem[], timeZone?: string) {
  const ranked = rankTasks(reminders).slice(0, 3);
  if (ranked.length === 0) return "You have no pending reminders right now.";
  const lines = ranked.map(
    (item, index) =>
      `${index + 1}. ${item.title} — ${formatDueInUserZone(item.dueAt, timeZone)}`
  );
  return [
    ranked.length === 1 ? "Your best next task is:" : "Your top next tasks are:",
    ...lines,
  ].join("\n");
}

function formatPlanningReply(reminders: ReminderItem[], timeZone?: string) {
  const analysis = analyzeSchedule(reminders, new Date(), { timeZone });
  const lines: string[] = [];
  if (analysis.nextTask) {
    lines.push(
      `Start with ${analysis.nextTask.title} at ${formatDueInUserZone(analysis.nextTask.dueAt, timeZone)}.`
    );
  }
  if (analysis.overdueTasks.length > 0) {
    lines.push(`You have ${analysis.overdueTasks.length} overdue task(s).`);
  }
  if (analysis.conflicts.length > 0) {
    const conflict = analysis.conflicts[0];
    if (conflict) {
      lines.push(
        `Possible clash: ${conflict.first.title} and ${conflict.second.title} are ${conflict.minutesApart} minutes apart.`
      );
    }
  }
  if (analysis.freeSlots.length > 0) {
    lines.push(`Free slot: ${analysis.freeSlots[0]}`);
  }
  return lines.join("\n") || "You have no pending reminders to plan right now.";
}

/**
 * Builds a helpful, context-rich fallback response when no fast path or LLM produces an answer.
 * NEVER returns a generic "I don't understand" / "rephrase" message — always shows the user
 * something actionable so they don't lose trust in the assistant.
 */
function buildHelpfulFallback(reminders: ReminderItem[], timeZone?: string): string {
  const pending = reminders.filter((r) => r.status !== "done" && r.status !== "archived");

  if (pending.length === 0) {
    return "You don't have any pending reminders right now. Want me to create one? Just say something like \"remind me to call mom tomorrow at 6pm\".";
  }

  // Show the 3 most urgent (rankTasks already prioritises overdue → due-soonest → priority)
  const top = rankTasks(reminders).slice(0, 3);
  if (top.length === 0) {
    return `You have ${pending.length} pending reminder${pending.length === 1 ? "" : "s"}. Try asking "what's due today?" or "show my missed reminders".`;
  }

  const lines = top.map(
    (item, idx) => `${idx + 1}. ${item.title} — ${formatDueInUserZone(item.dueAt, timeZone)}`
  );
  return [
    `Here's what's most urgent (${pending.length} pending in total):`,
    ...lines,
    "",
    "Tell me which one you want details on, or ask me to list/create/complete any reminder.",
  ].join("\n");
}

function fallbackDeterministicReply(message: string, reminders: ReminderItem[], timeZone?: string) {
  const intent = classifyReminderIntent(message);
  if (intent === "decision_query") return formatDecisionReply(reminders, timeZone);
  if (intent === "planning_query") return formatPlanningReply(reminders, timeZone);

  const listScope = inferListScopeFromMessage(message);
  if (listScope === "today") {
    const today = filterToday(reminders, new Date(), timeZone).slice(0, 5);
    if (today.length === 0) return "You have no reminders for today.";
    return [
      "Here are your reminders for today:",
      ...today.map((item, idx) => `${idx + 1}. ${describeReminderForChat(item, new Date(), { timeZone })}`),
    ].join("\n");
  }
  if (listScope) return buildListRemindersReply(reminders, listScope, new Date(), 5, { timeZone });

  // Try grounded answer (decision/detail/planning); if that returns null, fall back to a
  // helpful summary instead of a generic "I can help with..." message.
  const grounded = tryGroundedReminderAnswer(message, reminders, new Date(), { timeZone });
  if (grounded) return grounded;

  // Aggressive fuzzy match — last chance for deterministic answer
  const fuzzy = findReminderByFuzzyMatch(message, reminders, new Date(), { timeZone });
  if (fuzzy) return fuzzy;

  return buildHelpfulFallback(reminders, timeZone);
}

// ─── Date / time parsing ──────────────────────────────────────────────────────

function hasExplicitTime(input: string) {
  const normalized = input
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/([ap])\.\s?m\.(?!\w)/gi, "$1m");
  return /\b(\d{1,2})(?:[:.]\d{2})?\s?(am|pm)\b/i.test(normalized)
    || /\b\d{1,2}[:.]\d{2}\b/.test(input)
    || /(?:^|\s)\d{1,2}\s*(?:बजे|वाजता|वाजले)(?=\s|$|[,.!?])/i.test(normalized)
    || /(?:^|\s)(सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात)(?=\s|$|[,.!?])/i.test(normalized)
    || /\b(noon|midnight)\b/i.test(input)
    || /\b(morning|afternoon|evening|night)\b/i.test(input)
    || /\bin\s+\d+\s*(hour|hr|minute|min)s?\b/i.test(input);
}

function hasTodayHint(input: string) {
  return /\btoday\b/i.test(input) || /(^|\s)आज(?=\s|$|[,.!?])/i.test(input);
}

function hasTomorrowHint(input: string) {
  return /\b(tomorrow|tomorow|tommarow|tmrw)\b/i.test(input)
    || /(^|\s)(कल|उद्या)(?=\s|$|[,.!?])/i.test(input);
}

function hasDayAfterTomorrowHint(input: string) {
  return /\b(day after tomorrow|after tomorrow)\b/i.test(input)
    || /(^|\s)(परसों|परवा)(?=\s|$|[,.!?])/i.test(input);
}

function parseTimeFromInput(input: string) {
  const normalized = input
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/([ap])\.\s?m\.(?!\w)/gi, "$1m");

  const meridiemMatch = normalized.match(/\b(\d{1,2})(?:[:.]\s*(\d{2}))?\s?(am|pm)\b/i);
  if (meridiemMatch) {
    const rawHour = Number.parseInt(meridiemMatch[1] ?? "0", 10);
    const minute = Number.parseInt(meridiemMatch[2] ?? "0", 10);
    if (!Number.isFinite(rawHour) || rawHour < 1 || rawHour > 12) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    const meridiem = (meridiemMatch[3] ?? "am").toLowerCase();
    let hour = rawHour % 12;
    if (meridiem === "pm") hour += 12;
    return { hour, minute };
  }

  const clockMatch = input.match(/\b(\d{1,2})[:.]\s*(\d{2})\b/);
  if (clockMatch) {
    const hour = Number.parseInt(clockMatch[1] ?? "0", 10);
    const minute = Number.parseInt(clockMatch[2] ?? "0", 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }

  const regionalMatch = normalized.match(
    /(?:^|\s)(\d{1,2})(?:[:.]\s*(\d{2}))?\s*(?:बजे|वाजता|वाजले)?\s*(सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात)?(?=\s|$|[,.!?])/i,
  );
  if (regionalMatch) {
    const rawHour = Number.parseInt(regionalMatch[1] ?? "-1", 10);
    const minute = Number.parseInt(regionalMatch[2] ?? "0", 10);
    if (!Number.isFinite(rawHour) || rawHour < 0 || rawHour > 23) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    const part = (regionalMatch[3] ?? "").toLowerCase();
    if (!part && !/(?:बजे|वाजता|वाजले)/i.test(normalized)) return null;
    let hour = rawHour;
    if (part) {
      if (/सुबह|सकाळी/i.test(part)) { if (hour === 12) hour = 0; }
      else if (/दोपहर|दुपारी/i.test(part)) { if (hour >= 1 && hour <= 11) hour += 12; }
      else if (/शाम|सायंकाळी|रात/i.test(part)) { if (hour >= 1 && hour <= 11) hour += 12; }
    }
    return { hour, minute };
  }

  if (/\bnoon\b/i.test(input)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/i.test(input)) return { hour: 0, minute: 0 };
  if (/(?:^|\s)(दोपहर|दुपारी)(?=\s|$|[,.!?])/i.test(normalized)) return { hour: 12, minute: 0 };
  if (/(?:^|\s)(आधी रात|मध्यरात्र)(?=\s|$|[,.!?])/i.test(normalized)) return { hour: 0, minute: 0 };
  if (/\bmorning\b/i.test(input)) return { hour: 9, minute: 0 };
  if (/\bafternoon\b/i.test(input)) return { hour: 14, minute: 0 };
  if (/\bevening\b/i.test(input)) return { hour: 19, minute: 0 };
  if (/\bnight\b/i.test(input)) return { hour: 21, minute: 0 };
  return null;
}

function getCalendarDateInTimeZone(date: Date, timeZone?: string) {
  if (!timeZone) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>;
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function addDaysToCalendarDate(value: { year: number; month: number; day: number }, days: number) {
  const utc = new Date(Date.UTC(value.year, value.month - 1, value.day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>;
  const zonedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return (zonedAsUtc - date.getTime()) / 60000;
}

function calendarDateTimeToIso(
  calendar: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timeZone?: string,
) {
  if (!timeZone) {
    const date = new Date();
    date.setHours(time.hour, time.minute, 0, 0);
    date.setFullYear(calendar.year, calendar.month - 1, calendar.day);
    return date.toISOString();
  }
  const utcGuess = Date.UTC(calendar.year, calendar.month - 1, calendar.day, time.hour, time.minute, 0, 0);
  const firstOffset = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  let utcInstant = utcGuess - firstOffset * 60_000;
  const secondOffset = getTimeZoneOffsetMinutes(new Date(utcInstant), timeZone);
  if (secondOffset !== firstOffset) utcInstant = utcGuess - secondOffset * 60_000;
  return new Date(utcInstant).toISOString();
}

// ─── Extended date parsers ─────────────────────────────────────────────────────

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTH_MAP: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

/** "next Friday", "this Monday", "on Thursday" → calendar date in user's timezone */
function parseWeekdayTarget(input: string, timeZone?: string): string | null {
  const n = input.toLowerCase();
  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    const day = WEEKDAY_NAMES[i]!;
    const isNext = new RegExp(`\\b(next|coming)\\s+${day}\\b`).test(n);
    const isThis = new RegExp(`\\bthis\\s+${day}\\b`).test(n);
    const isOn   = new RegExp(`\\bon\\s+${day}\\b`).test(n);
    const isPlain = new RegExp(`\\b${day}\\b`).test(n);
    if (!isNext && !isThis && !isOn && !isPlain) continue;

    const time = parseTimeFromInput(input);
    if (!time) return null;

    const now = new Date();
    const today = getCalendarDateInTimeZone(now, timeZone);
    const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
    const currentWeekday = todayUtc.getUTCDay();

    let daysUntil = i - currentWeekday;
    if (isNext) {
      // "next X" = at least 1 day away; if same day, go to next week
      if (daysUntil <= 0) daysUntil += 7;
    } else {
      // "this X" / plain "X" = next upcoming occurrence (never today itself)
      if (daysUntil <= 0) daysUntil += 7;
    }

    const targetDay = addDaysToCalendarDate(today, daysUntil);
    return calendarDateTimeToIso(targetDay, time, timeZone);
  }
  return null;
}

/** "in 2 hours", "in 30 minutes", "in 3 days" → ISO string */
function parseRelativeOffset(input: string): string | null {
  const match = input.toLowerCase().match(/\bin\s+(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day|week)s?\b/);
  if (!match) return null;
  const amount = parseFloat(match[1]!);
  const unit = match[2]!;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 8760) return null;
  const ms =
    /^(hour|hr)/.test(unit) ? amount * 3_600_000 :
    /^(minute|min)/.test(unit) ? amount * 60_000 :
    /^day/.test(unit) ? amount * 86_400_000 :
    /^week/.test(unit) ? amount * 7 * 86_400_000 : 0;
  if (!ms) return null;
  return new Date(Date.now() + ms).toISOString();
}

/** "May 15", "June 5th", "15 April", "5/15" → ISO string in user's timezone */
function parseAbsoluteDate(input: string, timeZone?: string): string | null {
  const n = input.toLowerCase();

  for (const [monthName, monthNum] of Object.entries(MONTH_MAP)) {
    // Skip "may" as standalone word — too ambiguous ("may I", "you may")
    if (monthName === "may" && !new RegExp(`\\bmay\\s+\\d`).test(n) && !new RegExp(`\\b\\d.*\\bmay\\b`).test(n)) continue;
    const p1 = new RegExp(`\\b${monthName}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`);
    const p2 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthName}\\b`);
    const m1 = p1.exec(n);
    const m2 = m1 ? null : p2.exec(n);
    const dayStr = m1?.[1] ?? m2?.[1];
    if (!dayStr) continue;
    const dayNum = parseInt(dayStr, 10);
    if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) continue;
    const time = parseTimeFromInput(input);
    if (!time) return null;
    const now = new Date();
    const today = getCalendarDateInTimeZone(now, timeZone);
    let year = today.year;
    if (Date.UTC(year, monthNum - 1, dayNum, time.hour, time.minute) <= now.getTime()) year++;
    return calendarDateTimeToIso({ year, month: monthNum, day: dayNum }, time, timeZone);
  }

  // Numeric MM/DD or MM-DD
  const numMatch = n.match(/\b(1[0-2]|0?[1-9])[\/\-](3[01]|[12]\d|0?[1-9])(?!\d)\b/);
  if (numMatch) {
    const monthNum = parseInt(numMatch[1]!, 10);
    const dayNum = parseInt(numMatch[2]!, 10);
    const time = parseTimeFromInput(input);
    if (!time) return null;
    const now = new Date();
    const today = getCalendarDateInTimeZone(now, timeZone);
    let year = today.year;
    if (Date.UTC(year, monthNum - 1, dayNum, time.hour, time.minute) <= now.getTime()) year++;
    return calendarDateTimeToIso({ year, month: monthNum, day: dayNum }, time, timeZone);
  }

  return null;
}

function parseDateTimeFromInput(input: string, timeZone?: string) {
  const now = new Date();
  let day = getCalendarDateInTimeZone(now, timeZone);
  if (hasDayAfterTomorrowHint(input)) {
    day = addDaysToCalendarDate(day, 2);
  } else if (hasTomorrowHint(input)) {
    day = addDaysToCalendarDate(day, 1);
  } else if (hasTodayHint(input)) {
    // no change
  } else {
    // Extended: weekday / relative offset / absolute date
    const weekdayResult = parseWeekdayTarget(input, timeZone);
    if (weekdayResult) return weekdayResult;
    const relativeResult = parseRelativeOffset(input);
    if (relativeResult) return relativeResult;
    const absoluteResult = parseAbsoluteDate(input, timeZone);
    if (absoluteResult) return absoluteResult;

    // No date hint at all — try time-only.
    // If the extracted time is still in the future TODAY, use today (the natural expectation
    // when a user says "remind me at 3pm" mid-afternoon). If the time has already passed,
    // schedule for tomorrow so the reminder is always in the future.
    const timeOnly = parseTimeFromInput(input);
    if (timeOnly) {
      const todayIso = calendarDateTimeToIso(day, timeOnly, timeZone);
      if (todayIso && new Date(todayIso).getTime() >= Date.now() - 60_000) {
        return todayIso; // still in the future today
      }
      // time already passed — bump to tomorrow
      return calendarDateTimeToIso(addDaysToCalendarDate(day, 1), timeOnly, timeZone);
    }
    return null;
  }
  const time = parseTimeFromInput(input);
  if (!time) return null;
  const iso = calendarDateTimeToIso(day, time, timeZone);
  // If the user said "today at X" but X has already passed, schedule for tomorrow
  // at the exact same time the user specified — don't silently change the time.
  if (iso && hasTodayHint(input) && new Date(iso).getTime() < Date.now() - 60_000) {
    return calendarDateTimeToIso(addDaysToCalendarDate(day, 1), time, timeZone);
  }
  return iso;
}

function isValidFutureIsoDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() - 60 * 1000;
}

function extractTitleFromCreateInput(input: string) {
  let working = input.trim();

  // Ordered prefix patterns — strip the intent phrase, keep the subject/action after it
  const prefixPatterns: RegExp[] = [
    /\bremind me to\s+/i,
    /\bremind myself\s+(to|about)\s+/i,
    /\bdon'?t\s+forget\s+to\s+/i,
    /\bi\s+(need|must|have|should|want)\s+to\s+remember\s+to\s+/i,
    /\b(can|could|please)\s+(you\s+)?remind\s+me\s+(to|about)\s+/i,
    /\bping\s+me\s+(at|about|for|when)\s+/i,
    /\b(alert|notify)\s+me\s+(at|about|for|when|to)\s+/i,
    /\bput\s+(a\s+)?reminder\s+(for|to|about)\s+/i,
    /\bi\s+have\s+(a\s+|an\s+)?/i,
    /\b(याद\s+दिलाना|याद\s+कराना|याद\s+रखना|रिमाइंडर\s+लगाओ)\s+/i,
  ];

  let stripped = false;
  for (const pattern of prefixPatterns) {
    const match = pattern.exec(working);
    if (match?.index !== undefined) {
      working = working.slice(match.index + match[0].length);
      stripped = true;
      break;
    }
  }

  if (!stripped) {
    working = working
      .replace(
        /^(?:please\s+)?(?:create|add|set|make|schedule|बनाओ|तैयार करो|set karo|करो)\s+(?:(?:a|an|the|my)\s+)?(?:reminder|रिमाइंडर|स्मरणपत्र)?\s*/i,
        "",
      )
      .trim();
  }
  const normalized = working
    .replace(/^(?:called|named|titled)\s+/i, "")
    .replace(/\b(for|about|called|named|titled|के लिए|साठी)\b/gi, " ")
    // Strip date/time keywords that are never part of the reminder *title*.
    // NOTE: morning|afternoon|evening|night are intentionally kept here because they
    // ARE valid parts of a title (e.g. "morning standup", "evening walk").
    // Time extraction uses parseTimeFromInput() on the original raw input, so removing
    // them from the title does not affect time resolution.
    .replace(
      /\b(today|tomorrow|tomorow|tommarow|tmrw|day after tomorrow|after tomorrow|आज|कल|उद्या|परसों|परवा|at|on|by|noon|midnight|next|this|coming|every|in|बजे|वाजता|वाजले|सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi,
      " "
    )
    .replace(/\bin\s+\d+\s*(hour|hr|minute|min|day|week)s?\b/gi, " ")
    .replace(/\b\d+\s*(hour|hr|minute|min|day|week)s?\b/gi, " ")
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s?([ap]\.?m\.?)\b/gi, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

// ─── FLAW-2: extract metadata from natural language for deterministic create ──

function extractPriorityFromInput(input: string): number | undefined {
  const n = input.toLowerCase();
  if (/\b(critical|urgent|asap|immediately)\b/.test(n)) return 5;
  if (/\b(high\s*priority|very\s*important|top\s*priority)\b/.test(n)) return 4;
  if (/\b(important|priority)\b/.test(n)) return 3;
  if (/\b(low\s*priority|whenever|sometime)\b/.test(n)) return 2;
  return undefined;
}

function extractDomainFromInput(input: string): LifeDomain | undefined {
  const n = input.toLowerCase();
  if (/\bhealth\b/.test(n)) return "health";
  if (/\b(finance|financial|money|bank|budget|invest)\b/.test(n)) return "finance";
  if (/\b(career|work|job|office|meeting|professional)\b/.test(n)) return "career";
  if (/\bhobby\b/.test(n)) return "hobby";
  if (/\b(fun|entertainment|party|vacation)\b/.test(n)) return "fun";
  return undefined;
}

function extractRecurrenceFromInput(input: string): "daily" | "weekly" | "monthly" | undefined {
  const n = input.toLowerCase();
  if (/\b(every\s*day|daily)\b/.test(n)) return "daily";
  if (/\b(every\s*week|weekly)\b/.test(n)) return "weekly";
  if (/\b(every\s*month|monthly)\b/.test(n)) return "monthly";
  return undefined;
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found.");
  return text.slice(start, end + 1);
}

function safeAgentResponse(
  text: string,
  reminders?: ReminderItem[],
  timeZone?: string
): ReminderAgentResponse {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as ReminderAgentResponse;
    if (!parsed?.action?.type || !parsed?.reply) throw new Error("Invalid response shape.");

    // Detect unhelpful LLM hallucinations like "I don't see X in the context" and
    // replace with a context-aware helpful summary so the user always gets something useful.
    const replyLower = parsed.reply.toLowerCase();
    const looksUnhelpful =
      /i don'?t (see|have|find)|i can'?t (find|see)|not (in|mentioned in) (the|your|provided)|doesn'?t (mention|include|appear)|no (such|specific) (reminder|task)/.test(replyLower)
      && parsed.reply.length < 220;
    if (looksUnhelpful && reminders && reminders.length > 0) {
      return { reply: buildHelpfulFallback(reminders, timeZone), action: { type: "unknown" } };
    }
    return parsed;
  } catch {
    // Strip any code fences or JSON blobs (privacy: never leak full LLM JSON).
    const safe = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\{[\s\S]{40,}\}/g, "")
      .trim();
    // If the LLM produced any reasonable plain text, use it
    if (safe.length > 5 && safe.length < 600) {
      return { reply: safe, action: { type: "unknown" } };
    }
    // Otherwise produce a helpful context-aware summary — NEVER a generic error
    const reply = reminders
      ? buildHelpfulFallback(reminders, timeZone)
      : "I'm here to help with your reminders and tasks. Tell me what you'd like — list, create, complete, or update any reminder.";
    return { reply, action: { type: "unknown" } };
  }
}

// ─── Gap 2: deterministic target extraction for mark-done / delete ────────────

function extractTargetFromMarkDone(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(mark|set|flag|put)\s*(it|them|this|that)?\s*/gi, " ")
    .replace(/\b(as\s+)?(done|complete|completed|finished|finish)\b/gi, " ")
    .replace(/\bdone\s+with\b/gi, " ")
    .replace(/\b(i('?ve| have)\s+)?(done|completed|finished)\b/gi, " ")
    .replace(/\bcheck(ed)?\s*off\b/gi, " ")
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTargetFromDelete(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(delete|remove|cancel|dismiss|drop|trash|erase)\s*(it|them|this|that)?\s*/gi, " ")
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTargetFromReschedule(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    // Strip the action phrase "change the time/date of"
    .replace(/\b(change|update)\s+the\s+(time|date|due\s+date|due\s+time|schedule)\s*(of|for|on)?\s*/gi, " ")
    // Strip "reschedule/move/shift"
    .replace(/\b(reschedule|move|shift)\s*/gi, " ")
    // Strip everything from the new time onwards: "to today at 5pm", "to 5pm", "for tomorrow"
    .replace(/\b(to|for)\s+(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*/gi, " ")
    .replace(/\bto\s+\d{1,2}(:\d{2})?\s*(am|pm)\b.*/gi, " ")
    // Strip loose date/time words left behind
    .replace(/\b(today|tomorrow|tonight|at|on|by|next|this|coming|morning|evening|afternoon|night|noon|midnight)\b/gi, " ")
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s?([ap]\.?m\.?)\b/gi, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    // Strip articles and reminder-type words
    .replace(/\b(my|the|a|an|reminder|reminders|for|about|it|that|this)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Gap 4: snooze helpers ────────────────────────────────────────────────────

const PRONOUN_TARGETS = new Set(["it", "that", "this", "them", "those", "one"]);

/** Returns delay in minutes, or null if no duration found in message. */
function extractSnoozeDelayMinutes(message: string): number | null {
  const n = message.toLowerCase();
  if (/\bhalf\s+an?\s+hour\b/.test(n) || /\bhalf\s+hour\b/.test(n)) return 30;
  if (/\ban?\s+hour\b/.test(n)) return 60;
  if (/\ba\s+few\s+minutes?\b/.test(n)) return 5;
  const match = n.match(/\b(\d+(?:\.\d+)?)\s*(hour|hr|h|minute|min|m)s?\b/);
  if (match) {
    const amount = parseFloat(match[1]!);
    const unit = match[2]!;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1440) return null;
    if (/^(hour|hr|h)/.test(unit)) return Math.round(amount * 60);
    if (/^(minute|min|m)/.test(unit)) return Math.round(amount);
  }
  return null;
}

function extractTargetFromSnooze(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(snooze|postpone|delay|push|remind me again|remind me later)\s*/gi, " ")
    .replace(/\b(by|for|in|after)\s+\d+\s*(hour|hr|minute|min|h|m)s?\b/gi, " ")
    .replace(/\b(half\s+(an?\s+)?hour|an?\s+hour|a\s+few\s+minutes?)\b/gi, " ")
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Gap 5: edit title/notes helpers ─────────────────────────────────────────

function extractEditField(message: string): "title" | "notes" | null {
  const n = message.toLowerCase();
  if (/\b(rename|retitle)\b/.test(n)) return "title";
  if (/\b(title|name)\b/.test(n)) return "title";
  if (/\bnotes?\b/.test(n)) return "notes";
  return null;
}

function extractNewValueFromEdit(message: string): string | null {
  // Quoted: to "value" or to 'value'
  const quotedTo = message.match(/\bto\s+"([^"]+)"\s*$/i) ?? message.match(/\bto\s+'([^']+)'\s*$/i);
  if (quotedTo?.[1]) return quotedTo[1].trim();
  // Quoted: with "value"
  const quotedWith = message.match(/\bwith\s+"([^"]+)"\s*$/i) ?? message.match(/\bwith\s+'([^']+)'\s*$/i);
  if (quotedWith?.[1]) return quotedWith[1].trim();
  // Unquoted after "to": take rest of string, skip if it looks like a date/time phrase
  const toMatch = message.match(/\bto\s+(.+?)\s*$/i);
  if (toMatch?.[1]) {
    const val = toMatch[1].trim();
    const looksLikeDate = /\b(am|pm|tomorrow|today|tonight|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|noon|midnight|\d{1,2}[:.]\d{2})\b/i.test(val);
    if (!looksLikeDate && val.length >= 2) return val;
  }
  // Unquoted after "with"
  const withMatch = message.match(/\bwith\s+(.+?)\s*$/i);
  if (withMatch?.[1] && withMatch[1].trim().length >= 2) return withMatch[1].trim();
  return null;
}

function extractTargetFromEdit(message: string): string {
  let working = message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(rename|retitle|change|update|edit|modify)\s*/gi, " ");
  // Strip "the title/name/notes of/for/on"
  working = working.replace(/\b(the\s+)?(title|name|notes?|description)\s+(?:of|for|on|in)\s*/gi, " ");
  working = working.replace(/\b(the\s+)?(title|name|notes?|description)\s*/gi, " ");
  // Strip separator and new value (everything after "to", "with", "as")
  working = working.replace(/\s+to\s+.+$/i, " ");
  working = working.replace(/\s+with\s+.+$/i, " ");
  working = working.replace(/\s+as\s+.+$/i, " ");
  return working
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Gap 6: bulk helpers ──────────────────────────────────────────────────────

function extractBulkOperation(message: string): "mark_done" | "delete" | null {
  const n = message.toLowerCase();
  if (/\b(delete|remove|cancel|dismiss|trash|erase)\b/.test(n)) return "delete";
  if (/\b(mark|set|flag)\b.{0,25}\b(done|complete|completed|finished)\b/.test(n)) return "mark_done";
  if (/\b(complete|finish)\b/.test(n)) return "mark_done";
  return null;
}

function extractBulkTargets(message: string, reminders: ReminderItem[], timeZone?: string): ReminderItem[] {
  const n = message.toLowerCase();
  const now = new Date();
  const sortByDue = (a: ReminderItem, b: ReminderItem) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  const pending = reminders.filter((r) => r.status === "pending");

  if (/\b(missed|overdue)\b/.test(n)) {
    return pending.filter((r) => new Date(r.dueAt).getTime() < now.getTime()).sort(sortByDue);
  }
  if (/\btoday\b/.test(n)) return filterToday(pending, now, timeZone);
  if (/\btomorrow\b/.test(n)) {
    return pending.filter((r) => getReminderBucket(r, now, timeZone) === "tomorrow").sort(sortByDue);
  }
  // Domain filters
  const DOMAIN_PATTERNS: [RegExp, LifeDomain][] = [
    [/\bhealth\b/, "health"],
    [/\b(finance|financial|money)\b/, "finance"],
    [/\b(career|work|job)\b/, "career"],
    [/\bhobby\b/, "hobby"],
    [/\b(fun|entertainment)\b/, "fun"],
  ];
  for (const [pattern, domain] of DOMAIN_PATTERNS) {
    if (pattern.test(n)) return pending.filter((r) => r.domain === domain).sort(sortByDue);
  }
  // Fix: if no scope keyword matched, return [] rather than ALL reminders —
  // prevents "complete every appointment" from bulk-targeting the entire account.
  return [];
}

// ─── Gap 7: multi-turn ordinal resolution ────────────────────────────────────

function extractOrdinalIndex(message: string): number | null {
  const n = message.toLowerCase();
  if (/\b(first|1st)\b/.test(n)) return 0;
  if (/\b(second|2nd)\b/.test(n)) return 1;
  if (/\b(third|3rd)\b/.test(n)) return 2;
  if (/\b(fourth|4th)\b/.test(n)) return 3;
  if (/\b(fifth|5th)\b/.test(n)) return 4;
  if (/\blast\b/.test(n)) return -1; // -1 = last index
  return null;
}

/** Resolve "the first one / the last one" against the last listed set. Returns null if no match. */
function resolveByOrdinal(
  message: string,
  reminders: ReminderItem[],
  recentListedIds: string[] | undefined,
): ReminderItem | null {
  if (!recentListedIds?.length) return null;
  const ordinal = extractOrdinalIndex(message);
  if (ordinal === null) return null;
  const idx = ordinal === -1 ? recentListedIds.length - 1 : ordinal;
  const id = recentListedIds[idx];
  if (!id) return null;
  return reminders.find((r) => r.id === id && r.status === "pending") ?? null;
}

// ─── Gap 8: profile-based time suggestion ─────────────────────────────────────

function computeDomainHourPatterns(events: Array<Record<string, unknown>>): Record<string, number> {
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

function inferDomainFromTitle(title: string): LifeDomain | undefined {
  const t = title.toLowerCase();
  if (/\b(medicine|pill|doctor|health|gym|workout|run|yoga|exercise|appointment|dentist|hospital)\b/.test(t)) return "health";
  if (/\b(pay|bill|bank|budget|invest|tax|salary|finance|money|loan|insurance)\b/.test(t)) return "finance";
  if (/\b(meeting|work|boss|client|project|deadline|review|presentation|interview|standup|sprint|office)\b/.test(t)) return "career";
  if (/\b(hobby|craft|paint|guitar|book|read|learn|course|class|practice)\b/.test(t)) return "hobby";
  if (/\b(movie|party|dinner|game|concert|friend|fun|hangout|travel|trip)\b/.test(t)) return "fun";
  return undefined;
}

function suggestDomainTime(
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

async function loadProfileForSuggestion(userId: string): Promise<{
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

const LIFE_DOMAINS = new Set(["health", "finance", "career", "hobby", "fun"]);

function parseLifeDomain(value: unknown): LifeDomain | undefined {
  return typeof value === "string" && LIFE_DOMAINS.has(value) ? (value as LifeDomain) : undefined;
}

function fromDbReminder(item: Record<string, unknown>): ReminderItem {
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

function fromDbTask(item: Record<string, unknown>): TaskItem {
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

async function loadRemindersForChat(userId: string, fallback: ReminderItem[]): Promise<ReminderItem[]> {
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

async function loadTasksForChat(userId: string, fallback: TaskItem[]): Promise<TaskItem[]> {
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
const WIKI_STALE_MS = 60 * 60 * 1000; // 1 hour

async function loadUserWiki(userId: string): Promise<string> {
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

// FLAW-5: limit reminders sent to LLM — pending only, most relevant first, max 50
function filterRemindersForLLM(reminders: ReminderItem[]): ReminderItem[] {
  const now = Date.now();
  const pending = reminders
    .filter((r) => r.status === "pending")
    .sort((a, b) => {
      const aOver = new Date(a.dueAt).getTime() < now ? 0 : 1;
      const bOver = new Date(b.dueAt).getTime() < now ? 0 : 1;
      if (aOver !== bOver) return aOver - bOver;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    })
    .slice(0, 50);
  // Include recently completed for context (last 7 days)
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentDone = reminders
    .filter((r) => r.status === "done" && new Date(r.updatedAt).getTime() > weekAgo)
    .slice(0, 5);
  return [...pending, ...recentDone];
}

// MISSING-2/3: load behavioral profile + events for the digest
async function buildBehaviorContext(userId: string): Promise<string> {
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
function saveMessageServerSide(
  _userId: string,
  _role: "user" | "assistant",
  _content: string,
): Promise<void> {
  return Promise.resolve();
}

function looksLikeConfirmation(message: string): boolean {
  const n = message.toLowerCase().trim();
  return /^(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|do it|proceed|correct|right|absolutely|definitely|sounds good|alright|all right|fine|please do it|please do|please proceed|that's right|that is right|affirmative|exactly|perfect|great|sure thing|of course|please|done|let's do it|lets do it)[\s!.,]*$/.test(n);
}

function findTargetReminder(reminders: ReminderItem[], targetId?: string, targetTitle?: string): ReminderItem | undefined {
  if (targetId) {
    const byId = reminders.find((r) => r.id === targetId);
    if (byId) return byId;
  }
  if (targetTitle) {
    return reminders.find((r) =>
      r.title.toLowerCase().includes(targetTitle.toLowerCase())
    );
  }
  return undefined;
}

function normalizeClientTimeZone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.length < 2 || t.length > 120) return undefined;
  return t;
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // FLAW-3: rate limit
  if (isRateLimited(userId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await request.json()) as {
    message?: string;
    reminders?: ReminderItem[];
    tasks?: TaskItem[];
    timeZone?: string;
    replyContext?: ReplyContextPayload;
    pendingAction?: {
      type: "mark_done" | "delete_reminder" | "create_reminder" | "edit_reminder";
      targetId?: string;
      targetTitle?: string;
      targetIds?: string[];
      title?: string;
      dueAt?: string;
      priority?: number;
      domain?: string;
      recurrence?: string;
      newTitle?: string;
      newNotes?: string;
    };
    recentListedIds?: string[];
  };
  const timeZone = normalizeClientTimeZone(body.timeZone);
  const message = body.message?.trim();
  const reminders = await loadRemindersForChat(userId, body.reminders ?? []);
  const tasks = await loadTasksForChat(userId, body.tasks ?? []);
  const taskTitleById = Object.fromEntries(tasks.map((t) => [t.id, t.title]));
  const displayOptions = { timeZone, taskTitleById };
  // Load chat history early — needed for snooze/task-link disambiguation recovery before the LLM path
  const history = await getChatHistory(userId);

  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });

  // ─── Confirmation execution: user replied "yes" to a pending_confirm ──────────
  if (body.pendingAction && looksLikeConfirmation(message)) {
    const { type: pendingType, targetId, targetTitle, targetIds } = body.pendingAction;

    // Gap 8: create suggestion confirmation
    if (pendingType === "create_reminder") {
      const { title, dueAt: suggestedDueAt } = body.pendingAction;
      if (title && suggestedDueAt && isValidFutureIsoDate(suggestedDueAt)) {
        const priority = typeof body.pendingAction.priority === "number" ? body.pendingAction.priority : undefined;
        const domain = parseLifeDomain(body.pendingAction.domain);
        const recurrence = (["none", "daily", "weekly", "monthly"] as const).includes(body.pendingAction.recurrence as any)
          ? (body.pendingAction.recurrence as "none" | "daily" | "weekly" | "monthly")
          : undefined;
        const reply = `Reminder "${title}" created for ${formatDueInUserZone(suggestedDueAt, timeZone)}.`;
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", reply);
        return NextResponse.json({
          reply,
          action: { type: "create_reminder", title, dueAt: suggestedDueAt, priority, domain, recurrence },
        } satisfies ReminderAgentResponse);
      }
    }

    // Edit confirmation
    if (pendingType === "edit_reminder" && (body.pendingAction?.newTitle || body.pendingAction?.newNotes !== undefined)) {
      const { newTitle, newNotes } = body.pendingAction;
      const editTarget = findTargetReminder(reminders, targetId, targetTitle);
      if (editTarget) {
        const field = newTitle !== undefined ? "title" : "notes";
        const reply = `Done — updated the ${field} of "${editTarget.title}".`;
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", reply);
        return NextResponse.json({
          reply,
          action: {
            type: "edit_reminder",
            targetId: editTarget.id,
            targetTitle: editTarget.title,
            ...(newTitle !== undefined ? { newTitle } : { newNotes }),
          },
        } satisfies ReminderAgentResponse);
      }
    }

    // Bulk confirmation: targetIds present → execute on all of them
    if (targetIds && targetIds.length > 0) {
      const op = pendingType === "delete_reminder" ? "delete" : "mark_done";
      const verb = op === "delete" ? "deleted" : "marked as done";
      const reply = `Done — ${targetIds.length} reminder${targetIds.length !== 1 ? "s" : ""} ${verb}.`;
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({
        reply,
        action: { type: "bulk_action", bulkOperation: op, bulkTargetIds: targetIds },
      } satisfies ReminderAgentResponse);
    }

    const target = findTargetReminder(reminders, targetId, targetTitle);
    if (target) {
      const verb = pendingType === "delete_reminder" ? "deleted" : "marked as done";
      const reply = `Done — "${target.title}" has been ${verb}.`;
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({
        reply,
        action: { type: pendingType, targetId: target.id, targetTitle: target.title },
      } satisfies ReminderAgentResponse);
    }
    // Target no longer found (already deleted/done) — tell the user
    const reply = "I couldn't find that reminder anymore — it may have already been updated.";
    void saveMessageServerSide(userId, "user", message);
    void saveMessageServerSide(userId, "assistant", reply);
    return NextResponse.json({ reply, action: { type: "unknown" } } satisfies ReminderAgentResponse);
  }

  const replyContext =
    body.replyContext
    && typeof body.replyContext.id === "string"
    && typeof body.replyContext.content === "string"
    && (body.replyContext.role === "user" || body.replyContext.role === "assistant" || body.replyContext.role === "system")
      ? body.replyContext : undefined;
  const effectiveMessage = buildMessageWithReplyContext(message, replyContext);

  // Issue 4 fix: decision/planning queries now fall through to the LLM path so they
  // benefit from the wiki's behavioral context (patterns, avoidance, completion rates).
  // Only purely action-based fast paths (create/list/mark-done/delete) bypass the LLM.
  // NOTE: Always classify on raw `message` — effectiveMessage contains wrapper text that
  // pollutes keyword classifiers and causes misclassification.
  const intent = classifyReminderIntent(message);

  if (looksLikeCreateIntent(message)) {
    const title = extractTitleFromCreateInput(message);
    const dueAt = parseDateTimeFromInput(message, timeZone);
    const resolvedTitle = title || DEFAULT_CHAT_REMINDER_TITLE;

    if (dueAt && isValidFutureIsoDate(dueAt)) {
      // FLAW-2: enrich with metadata extracted from the message
      const response: ReminderAgentResponse = {
        reply: `Reminder "${resolvedTitle}" created for ${formatDueInUserZone(dueAt, timeZone)}.`,
        action: {
          type: "create_reminder",
          title: resolvedTitle,
          dueAt,
          priority: extractPriorityFromInput(message),
          domain: extractDomainFromInput(message),
          recurrence: extractRecurrenceFromInput(message),
        },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", response.reply);
      return NextResponse.json(response);
    }

    // Gap 8: no time provided → suggest based on profile/domain instead of plain "please give time"
    const domain = extractDomainFromInput(message);
    const priority = extractPriorityFromInput(message);
    const recurrence = extractRecurrenceFromInput(message);
    const { profile, domainHourPatterns } = await loadProfileForSuggestion(userId);
    const suggested = suggestDomainTime(domain, resolvedTitle, profile, domainHourPatterns);

    // Pick the best available day (respect explicit hint in message; default to tomorrow)
    const now = new Date();
    const todayCal = getCalendarDateInTimeZone(now, timeZone);
    let suggestDay = addDaysToCalendarDate(todayCal, 1); // default: tomorrow
    if (hasDayAfterTomorrowHint(message)) {
      suggestDay = addDaysToCalendarDate(todayCal, 2);
    } else if (hasTodayHint(message)) {
      const todayTs = calendarDateTimeToIso(todayCal, suggested, timeZone);
      suggestDay = new Date(todayTs).getTime() > now.getTime()
        ? todayCal
        : addDaysToCalendarDate(todayCal, 1);
    }
    const suggestedDueAt = calendarDateTimeToIso(suggestDay, suggested, timeZone);
    const timeLabel = formatDueInUserZone(suggestedDueAt, timeZone);

    const response: ReminderAgentResponse = {
      reply: `I can create "${resolvedTitle}". Based on ${suggested.basis}, I suggest **${timeLabel}**. Reply **yes** to confirm, or tell me a different time.`,
      action: {
        type: "clarify",
        title: resolvedTitle,
        suggestedDueAt,
        priority,
        domain,
        recurrence,
      },
    };
    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", response.reply);
    return NextResponse.json(response);
  }

  // ─── Gap 6: bulk fast path (before single mark-done / delete) ────────────
  if (looksLikeBulkIntent(message)) {
    const op = extractBulkOperation(message);
    if (op) {
      const targets = extractBulkTargets(message, reminders, timeZone);
      if (targets.length === 0) {
        const r: ReminderAgentResponse = {
          reply: "You have no pending reminders matching that filter.",
          action: { type: "unknown" },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      const verb = op === "delete" ? "delete" : "mark as done";
      const count = targets.length;
      const preview = targets
        .slice(0, 5)
        .map((r) => `"${r.title}"`)
        .join(", ");
      const ellipsis = count > 5 ? ` (+${count - 5} more)` : "";
      const r: ReminderAgentResponse = {
        reply: `You have ${count} reminder${count !== 1 ? "s" : ""}: ${preview}${ellipsis}. ${count === 1 ? "It" : "All"} will be ${op === "delete" ? "deleted" : "marked as done"}. Reply **yes** to confirm.`,
        action: {
          type: "pending_confirm",
          pendingType: op === "delete" ? "delete_reminder" : "mark_done",
          bulkTargetIds: targets.map((r) => r.id),
        },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }
    // op unknown — fall through to LLM
  }

  // ─── Gap 2: deterministic mark-done fast path ──────────────────────────────
  if (looksLikeMarkDoneIntent(message)) {
    const ordinalTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    if (ordinalTarget) {
      const r: ReminderAgentResponse = {
        reply: `Are you sure you want to mark "${ordinalTarget.title}" — ${formatDueInUserZone(ordinalTarget.dueAt, timeZone)} as done? Reply **yes** to confirm.`,
        action: { type: "pending_confirm", pendingType: "mark_done", targetId: ordinalTarget.id, targetTitle: ordinalTarget.title },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }
    const rawTarget = extractTargetFromMarkDone(message);
    if (rawTarget.length >= 2) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && r.title.toLowerCase().includes(rawTarget.toLowerCase()),
      );
      if (matches.length === 1) {
        const target = matches[0]!;
        const r: ReminderAgentResponse = {
          reply: `Are you sure you want to mark "${target.title}" — ${formatDueInUserZone(target.dueAt, timeZone)} as done? Reply **yes** to confirm.`,
          action: { type: "pending_confirm", pendingType: "mark_done", targetId: target.id, targetTitle: target.title },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}" at ${formatDueInUserZone(r.dueAt, timeZone)}`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify", pendingOp: "mark_done", candidateIds: matches.map((m) => m.id) },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      // Zero matches — fall through to LLM
    }
  }

  // ─── Gap 2: deterministic delete fast path ─────────────────────────────────
  if (looksLikeDeleteIntent(message)) {
    const ordinalTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    if (ordinalTarget) {
      const r: ReminderAgentResponse = {
        reply: `Are you sure you want to delete "${ordinalTarget.title}" — ${formatDueInUserZone(ordinalTarget.dueAt, timeZone)}? Reply **yes** to confirm.`,
        action: { type: "pending_confirm", pendingType: "delete_reminder", targetId: ordinalTarget.id, targetTitle: ordinalTarget.title },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }
    const rawTarget = extractTargetFromDelete(message);
    if (rawTarget.length >= 2) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && r.title.toLowerCase().includes(rawTarget.toLowerCase()),
      );
      if (matches.length === 1) {
        const target = matches[0]!;
        const r: ReminderAgentResponse = {
          reply: `Are you sure you want to delete "${target.title}" — ${formatDueInUserZone(target.dueAt, timeZone)}? Reply **yes** to confirm.`,
          action: { type: "pending_confirm", pendingType: "delete_reminder", targetId: target.id, targetTitle: target.title },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}" at ${formatDueInUserZone(r.dueAt, timeZone)}`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify", pendingOp: "delete", candidateIds: matches.map((m) => m.id) },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      // Zero matches — fall through to LLM
    }
  }

  // ─── Reschedule fast path ─────────────────────────────────────────────────
  if (looksLikeRescheduleIntent(message)) {
    const newDueAt = parseDateTimeFromInput(message, timeZone);

    if (!newDueAt || !isValidFutureIsoDate(newDueAt)) {
      const r: ReminderAgentResponse = {
        reply: "What time should I reschedule it to?",
        action: { type: "clarify" },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    const ordinalTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    const rawTarget = extractTargetFromReschedule(message);
    const isPronoun = !rawTarget || rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase());
    let target: ReminderItem | undefined = ordinalTarget ?? undefined;

    if (!target && !isPronoun) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && r.title.toLowerCase().includes(rawTarget.toLowerCase()),
      );
      if (matches.length === 1) target = matches[0];
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}" at ${formatDueInUserZone(r.dueAt, timeZone)}`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
    }

    if (target) {
      const r: ReminderAgentResponse = {
        reply: `Rescheduled "${target.title}" to ${formatDueInUserZone(newDueAt, timeZone)}.`,
        action: { type: "reschedule_reminder", targetId: target.id, targetTitle: target.title, dueAt: newDueAt },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }
    // Target not resolved — fall through to LLM
  }

  // ─── Gap 5: edit title/notes fast path ────────────────────────────────────
  if (looksLikeEditIntent(message)) {
    const field = extractEditField(message);
    const newValue = extractNewValueFromEdit(message);

    if (!field) {
      const r: ReminderAgentResponse = {
        reply: "What would you like to change — the title or the notes?",
        action: { type: "clarify" },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    if (!newValue) {
      const r: ReminderAgentResponse = {
        reply: `What should the new ${field} be?`,
        action: { type: "clarify" },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    const ordinalEditTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    if (ordinalEditTarget) {
      const previewValue = newValue.length > 40 ? `${newValue.slice(0, 40)}…` : newValue;
      const r: ReminderAgentResponse = {
        reply: `Change the ${field} of "${ordinalEditTarget.title}" to "${previewValue}"? Reply **yes** to confirm.`,
        action: {
          type: "pending_confirm",
          pendingType: "edit_reminder",
          targetId: ordinalEditTarget.id,
          targetTitle: ordinalEditTarget.title,
          ...(field === "title" ? { newTitle: newValue } : { newNotes: newValue }),
        },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    const rawTarget = extractTargetFromEdit(message);
    const isPronoun = !rawTarget || rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase());

    if (!isPronoun) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && r.title.toLowerCase().includes(rawTarget.toLowerCase()),
      );
      if (matches.length === 1) {
        const target = matches[0]!;
        const previewValue = newValue.length > 40 ? `${newValue.slice(0, 40)}…` : newValue;
        const r: ReminderAgentResponse = {
          reply: `Change the ${field} of "${target.title}" to "${previewValue}"? Reply **yes** to confirm.`,
          action: {
            type: "pending_confirm",
            pendingType: "edit_reminder",
            targetId: target.id,
            targetTitle: target.title,
            ...(field === "title" ? { newTitle: newValue } : { newNotes: newValue }),
          },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}"`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
      // Zero matches — fall through to LLM
    }
    // Pronoun or no target — fall through to LLM for disambiguation
  }

  // ─── Fix 5: snooze disambiguation recovery ───────────────────────────────────
  // If the last assistant message was a snooze "which one?" clarify, the user's current
  // reply is just a reminder name — looksLikeSnoozeIntent won't match. Recover the
  // delay from the original snooze message (2 turns back) and resolve the target now.
  {
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const isSnoozeDisambig = lastAssistant?.content?.match(/which one do you mean.*\?/i) !== null;
    if (isSnoozeDisambig) {
      // Find the original user snooze message (the one before the clarify)
      const userMessages = [...history].filter((m) => m.role === "user");
      const originalSnoozeMsg = userMessages[userMessages.length - 1]?.content ?? "";
      const recoveredDelay = extractSnoozeDelayMinutes(originalSnoozeMsg);
      if (recoveredDelay) {
        const rawTarget = message.trim();
        const matches = reminders.filter(
          (r) => r.status === "pending" && r.title.toLowerCase().includes(rawTarget.toLowerCase()),
        );
        const target = matches.length === 1 ? matches[0] : (matches[0] ?? undefined);
        if (target) {
          const newDueAt = new Date(Date.now() + recoveredDelay * 60_000).toISOString();
          const label =
            recoveredDelay >= 60
              ? `${Math.round(recoveredDelay / 60)} hour${Math.round(recoveredDelay / 60) !== 1 ? "s" : ""}`
              : `${recoveredDelay} minute${recoveredDelay !== 1 ? "s" : ""}`;
          const r: ReminderAgentResponse = {
            reply: `Snoozed "${target.title}" — I'll remind you again in ${label} (${formatDueInUserZone(newDueAt, timeZone)}).`,
            action: { type: "snooze_reminder", targetId: target.id, targetTitle: target.title, delayMinutes: recoveredDelay },
          };
          void saveMessageServerSide(userId, "user", effectiveMessage);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
      }
    }
  }

  // ─── Gap 4: snooze fast path ───────────────────────────────────────────────
  if (looksLikeSnoozeIntent(message)) {
    const delayMinutes = extractSnoozeDelayMinutes(message);

    if (!delayMinutes) {
      const r: ReminderAgentResponse = {
        reply: "How long should I snooze it? For example: 30 minutes, 1 hour, 2 hours.",
        action: { type: "clarify" },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    // Gap 7: ordinal resolution ("snooze the second one by 30 min")
    const ordinalSnoozeTarget = resolveByOrdinal(message, reminders, body.recentListedIds);

    const rawTarget = extractTargetFromSnooze(message);
    const isPronoun = !rawTarget || rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase());
    let target: ReminderItem | undefined = ordinalSnoozeTarget ?? undefined;

    if (!target && !isPronoun) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && r.title.toLowerCase().includes(rawTarget.toLowerCase()),
      );
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}"`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return NextResponse.json(r);
      }
    }

    // No explicit title (or pronoun) → pick nearest overdue, then nearest upcoming
    if (!target) {
      const pending = reminders
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
      const overdue = pending.filter((r) => new Date(r.dueAt).getTime() < Date.now());
      target = overdue[0] ?? pending[0];
    }

    if (!target) {
      const r: ReminderAgentResponse = {
        reply: "You have no pending reminders to snooze.",
        action: { type: "unknown" },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    const newDueAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    const label =
      delayMinutes >= 60
        ? `${Math.round(delayMinutes / 60)} hour${Math.round(delayMinutes / 60) !== 1 ? "s" : ""}`
        : `${delayMinutes} minute${delayMinutes !== 1 ? "s" : ""}`;
    const r: ReminderAgentResponse = {
      reply: `Snoozed "${target.title}" — I'll remind you again in ${label} (${formatDueInUserZone(newDueAt, timeZone)}).`,
      action: { type: "snooze_reminder", targetId: target.id, targetTitle: target.title, delayMinutes },
    };
    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", r.reply);
    return NextResponse.json(r);
  }

  const listScopeFromMessage = inferListScopeFromMessage(message);
  if (listScopeFromMessage && !isCompoundReminderQuestion(message)) {
    let reply: string;
    let listedIds: string[];
    if (listScopeFromMessage === "today") {
      // BUG-3 fix: pass timezone to filterToday
      const today = filterToday(reminders, new Date(), timeZone).slice(0, 5);
      listedIds = today.map((r) => r.id);
      reply = today.length === 0
        ? "You have no reminders for today."
        : [
          today.length === 1 ? "Here is your reminder for today:" : "Here are your reminders for today:",
          ...today.map((item, idx) => `${idx + 1}. ${describeReminderForChat(item, new Date(), displayOptions)}`),
        ].join("\n");
    } else {
      // Issue 3 fix: pass timeZone so bucket boundaries (missed/tomorrow/later) use the user's calendar day
      const listed = filterRemindersByListScope(reminders, listScopeFromMessage, new Date(), timeZone).slice(0, 5);
      listedIds = listed.map((r) => r.id);
      reply = buildListRemindersReply(reminders, listScopeFromMessage, new Date(), 5, displayOptions);
    }
    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", reply);
    return NextResponse.json({ reply, action: { type: "list_reminders", listedIds } } satisfies ReminderAgentResponse);
  }

  // Fast path: detail query about a specific reminder ("tell me about hupendra work",
  // "what time is the dentist", "more details on gym reminder").
  // tryGroundedReminderAnswer uses fuzzy title matching — handles typos and no "reminder" keyword.
  // Runs BEFORE LLM so these never hit NVIDIA when a deterministic answer exists.
  if (!isCompoundReminderQuestion(message)) {
    const grounded = tryGroundedReminderAnswer(message, reminders, new Date(), displayOptions);
    if (grounded) {
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", grounded);
      return NextResponse.json({ reply: grounded, action: { type: "unknown" } } satisfies ReminderAgentResponse);
    }
    // Aggressive last-resort fuzzy match: catches "what did you know about the dynamic humor",
    // "what happened with cli update", "any update on gym thing" — phrasings that don't fit any
    // "tell me about" pattern but clearly reference a reminder by 2+ unique title tokens.
    const fuzzy = findReminderByFuzzyMatch(message, reminders, new Date(), displayOptions);
    if (fuzzy) {
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", fuzzy);
      return NextResponse.json({ reply: fuzzy, action: { type: "unknown" } } satisfies ReminderAgentResponse);
    }
  }

  const nimApiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!nimApiKey) {
    const reply = fallbackDeterministicReply(message, reminders, timeZone);
    void saveMessageServerSide(userId, "user", message);
    void saveMessageServerSide(userId, "assistant", reply);
    return NextResponse.json({ reply, action: { type: "unknown" } } satisfies ReminderAgentResponse);
  }

  try {
    const model = process.env.NVIDIA_NIM_MODEL ?? DEFAULT_MODEL;

    // BUG-5 fix: only pending+recent-done reminders in JSON sent to LLM
    const llmReminders = filterRemindersForLLM(reminders);
    const digest = buildLifeOsContextBlock(llmReminders, tasks, new Date(), displayOptions);

    // Issue 6 fix: wiki is the single source of behavioral context — no need for
    // the redundant buildBehaviorContext which queries the same Convex tables again.
    const wikiCtx = await loadUserWiki(userId);

    // BUG-1 / MISSING-1 fix: inject recent conversation history (already loaded above)
    const recentHistory = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_HISTORY_TURNS);

    // Build the user turn content — wiki comes first (rich synthesised knowledge),
    // then the live digest (current reminders),
    // then the machine-readable JSON for precise CRUD actions.
    // NOTE: Always use `message` (the raw user text) here — never effectiveMessage which
    // contains a [The user is replying to...] wrapper that causes the LLM to echo it back.
    // Reply context is provided as a clean bracketed note instead.
    const replyContextNote = replyContext?.content?.trim()
      ? `\n\n[Reply context: responding to — "${replyContext.content.trim().slice(0, 200)}"]`
      : "";
    const contextParts = [
      message,
      replyContextNote,
      wikiCtx ? `\n\n${wikiCtx}` : "",
      `\n\n--- LIFE OS DIGEST (authoritative) ---\n${digest}`,
      `\n\n--- LIFE OS JSON (same data, machine-readable) ---\n${JSON.stringify({ reminders: llmReminders, tasks })}`,
    ].join("");

    const nimMessages = [
      { role: "system" as const, content: systemPrompt },
      ...recentHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: contextParts },
    ];

    const nimResponse = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nimApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: nimMessages, temperature: 0.2, max_tokens: 900 }),
    });

    if (nimResponse.status === 429 || !nimResponse.ok) {
      const reply = fallbackDeterministicReply(message, reminders, timeZone);
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({ reply, action: { type: "unknown" } } satisfies ReminderAgentResponse);
    }

    const data = (await nimResponse.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    // Pass reminders + timeZone so unhelpful LLM replies are replaced with a useful summary
    const parsed = safeAgentResponse(content, reminders, timeZone);

    if (parsed.action.type === "list_reminders") {
      const scope =
        mapAgentScopeToListScope(parsed.action.scope) ?? inferListScopeFromMessage(message) ?? "future";
      if (scope === "today") {
        const today = filterToday(reminders, new Date(), timeZone).slice(0, 5);
        parsed.action.listedIds = today.map((r) => r.id);
        parsed.reply = today.length === 0
          ? "You have no reminders for today."
          : ["Here are your reminders for today:", ...today.map((item, idx) => `${idx + 1}. ${describeReminderForChat(item, new Date(), displayOptions)}`)].join("\n");
      } else {
        // Issue 3 fix: pass timeZone so bucket boundaries use the user's calendar day
        const listed = filterRemindersByListScope(reminders, scope, new Date(), timeZone).slice(0, 5);
        parsed.action.listedIds = listed.map((r) => r.id);
        parsed.reply = buildListRemindersReply(reminders, scope, new Date(), 5, displayOptions);
      }
    }

    if (parsed.action.type === "create_reminder") {
      const deterministicDueAt = parseDateTimeFromInput(message, timeZone);
      if (deterministicDueAt) parsed.action.dueAt = deterministicDueAt;

      // FLAW-2: enrich LLM-generated create action with extracted metadata
      if (!parsed.action.priority) parsed.action.priority = extractPriorityFromInput(message);
      if (!parsed.action.domain) parsed.action.domain = extractDomainFromInput(message);
      if (!parsed.action.recurrence) parsed.action.recurrence = extractRecurrenceFromInput(message);

      // If the deterministic parser resolved a date, trust it and skip the clarify checks
      if (!deterministicDueAt) {
        const asksForRelativeDate =
          hasTodayHint(message) || hasTomorrowHint(message) || hasDayAfterTomorrowHint(message);
        if (asksForRelativeDate) {
          const r: ReminderAgentResponse = {
            reply: "I understood you want to create a reminder, but I could not confidently parse the date/time. Please resend with clear format like: tomorrow at 8:00 PM.",
            action: { type: "clarify", title: parsed.action.title },
          };
          void saveMessageServerSide(userId, "user", effectiveMessage);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }

        if (!parsed.action.dueAt || !hasExplicitTime(message) || !isValidFutureIsoDate(parsed.action.dueAt)) {
          const r: ReminderAgentResponse = {
            reply: "I can create that reminder. Please confirm the exact time (for example: tomorrow at 8:00 PM).",
            action: { type: "clarify", title: parsed.action.title },
          };
          void saveMessageServerSide(userId, "user", effectiveMessage);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
      }

      // Only offer task-linking when the user's message itself contains task-related language.
      // Without this guard every LLM-path reminder creation interrupts with a task-link
      // question even for completely standalone intents ("remind me to drink water at 6pm").
      const hasTaskHint = /\b(task|project|link(ed)?|attach|connect|related\s+to|for\s+the\s+task)\b/i.test(message);
      if (tasks && tasks.length > 0 && !parsed.action.linkedTaskId && hasTaskHint) {
        const pendingTasks = tasks.filter((t) => (t as unknown as Record<string, unknown>).status === "pending");
        if (pendingTasks.length > 0) {
          // Fix 3: check if the last assistant message was already the task-link question.
          // If so, resolve the user's answer here instead of asking again (prevents infinite loop).
          const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
          const wasAskingTaskLink = lastAssistant?.content?.includes("Should this reminder be linked to a task?");

          if (wasAskingTaskLink) {
            // User answered: a number picks a task; anything else → standalone
            const numMatch = message.trim().match(/^(\d+)/);
            if (numMatch?.[1]) {
              const idx = parseInt(numMatch[1], 10) - 1;
              if (idx >= 0 && idx < pendingTasks.length) {
                const chosen = pendingTasks[idx] as unknown as Record<string, unknown>;
                parsed.action.linkedTaskId = chosen.id as string;
              }
            }
            // else: no number → standalone (no linkedTaskId), fall through to create
          } else {
            const taskList = pendingTasks.slice(0, 5).map((t, idx) => `${idx + 1}. ${t.title}`).join("\n");
            const r: ReminderAgentResponse = {
              reply: `Got it. Should this reminder be linked to a task?\n\n${taskList}\n\nOr just say "no" if it's standalone.`,
              action: { type: "clarify", title: parsed.action.title, dueAt: parsed.action.dueAt },
            };
            void saveMessageServerSide(userId, "user", effectiveMessage);
            void saveMessageServerSide(userId, "assistant", r.reply);
            return NextResponse.json(r);
          }
        }
      }
    }

    if (
      (parsed.action.type === "delete_reminder" || parsed.action.type === "mark_done" || parsed.action.type === "reschedule_reminder")
      && !parsed.action.targetId && !parsed.action.targetTitle
    ) {
      // Show top 3 pending so the user can pick — never just "tell me which one"
      const top = rankTasks(reminders).slice(0, 3);
      const sample = top.length > 0
        ? "\n\nYour top pending reminders:\n" + top.map((r, i) => `${i + 1}. ${r.title} — ${formatDueInUserZone(r.dueAt, timeZone)}`).join("\n")
        : "";
      const r: ReminderAgentResponse = {
        reply: `Which reminder do you mean? Please tell me the title or pick one.${sample}`,
        action: { type: "clarify" },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    // ─── Gap 1: confirmation gate for mark_done / delete_reminder ───────────────
    if (parsed.action.type === "mark_done" || parsed.action.type === "delete_reminder") {
      const target = findTargetReminder(reminders, parsed.action.targetId, parsed.action.targetTitle);

      // Ambiguous: multiple reminders match — ask which one first
      if (!target && parsed.action.targetTitle) {
        const matches = reminders.filter((item) =>
          item.title.toLowerCase().includes(parsed.action.targetTitle!.toLowerCase())
        );
        if (matches.length > 1) {
          const sample = matches.slice(0, 2).map((item) => `${item.title} at ${formatDueInUserZone(item.dueAt, timeZone)}`);
          const r: ReminderAgentResponse = {
            reply: `Do you mean ${sample.join(" or ")}?`,
            action: { type: "clarify", targetTitle: parsed.action.targetTitle },
          };
          void saveMessageServerSide(userId, "user", effectiveMessage);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
      }

      const verb = parsed.action.type === "delete_reminder" ? "delete" : "mark as done";
      const label = target
        ? `"${target.title}" — ${formatDueInUserZone(target.dueAt, timeZone)}`
        : `"${parsed.action.targetTitle ?? "that reminder"}"`;
      const r: ReminderAgentResponse = {
        reply: `Are you sure you want to ${verb} ${label}? Reply **yes** to confirm.`,
        action: {
          type: "pending_confirm",
          pendingType: parsed.action.type,
          targetId: target?.id ?? parsed.action.targetId,
          targetTitle: target?.title ?? parsed.action.targetTitle,
        },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", parsed.reply);
    return NextResponse.json(parsed);

  } catch {
    const reply = fallbackDeterministicReply(message, reminders, timeZone);
    void saveMessageServerSide(userId, "user", message);
    void saveMessageServerSide(userId, "assistant", reply);
    return NextResponse.json({ reply, action: { type: "unknown" } });
  }
}
