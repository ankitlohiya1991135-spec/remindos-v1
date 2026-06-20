import type { ReminderAgentResponse } from "./types";
import { type ReminderItem } from "@repo/reminder";
import { buildHelpfulFallback } from "./format";

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NIM_DEFAULT_MODEL = "mistralai/mistral-medium-3.5-128b";

// ─── LLM create-intent resolver ("LLM interprets, deterministic validates") ─────

export interface LlmCreateResolution {
  /** Action-only title with date/time words removed, if the LLM produced one. */
  title?: string;
  /** ISO-8601 due timestamp the LLM resolved, or undefined when it gave no date. */
  dueAt?: string;
  /** True ONLY if the user stated an actual clock time (not just a day/date). */
  hasExplicitTime: boolean;
  recurrence?: "none" | "daily" | "weekly" | "monthly";
}

/**
 * Best-effort LLM interpretation of an arbitrary "create reminder" phrasing.
 *
 * This is the answer to brittle regex date parsing: it resolves ANY date
 * expression — "the day before my trip", "end of next week", "by the 20th",
 * "after lunch tomorrow" — against a real date anchor, in the user's timezone.
 *
 * It is a best-effort ENHANCEMENT, never a hard dependency: it returns null on
 * any failure (missing API key, timeout, non-OK response, malformed JSON) so the
 * caller falls back to deterministic parsing. The caller is expected to VALIDATE
 * the returned dueAt (isValidFutureIsoDate) before trusting it — the LLM
 * interprets, deterministic code validates.
 */
export async function resolveCreateWithLLM(
  message: string,
  opts: { timeZone?: string; nowMs?: number; timeoutMs?: number } = {},
): Promise<LlmCreateResolution | null> {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) return null;
  const model = process.env.NVIDIA_NIM_MODEL ?? NIM_DEFAULT_MODEL;
  const now = opts.nowMs ? new Date(opts.nowMs) : new Date();
  const tz = opts.timeZone ?? "UTC";

  let anchor: string;
  try {
    anchor = new Intl.DateTimeFormat("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz,
    }).format(now);
  } catch {
    anchor = now.toISOString();
  }

  const system =
    `You convert a reminder request into STRICT JSON. ` +
    `Current date & time: ${anchor} (timezone ${tz}). ` +
    `Resolve EVERY relative or informal date ("tomorrow", "next saturday", "the 20th", ` +
    `"end of next week", "in 3 days", "the day before my trip") to an absolute moment in that timezone. ` +
    `Reply with ONLY this JSON and nothing else: ` +
    `{"title":string,"dueAt":string|null,"hasExplicitTime":boolean,"recurrence":"none"|"daily"|"weekly"|"monthly"}. ` +
    `title = the action only, with NO date/time words. ` +
    `dueAt = ISO-8601 WITH timezone offset, or null if the user gave no date at all. ` +
    `hasExplicitTime = true only if the user stated a clock time (e.g. "5pm", "at 9:30"); ` +
    `if only a day/date was given, use 09:00 local and set hasExplicitTime=false. ` +
    `recurrence reflects "every day/week/month" or "every <weekday>", else "none".`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 9000);
    const res = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const obj = JSON.parse(extractJsonObject(content)) as Partial<LlmCreateResolution>;
    const recurrence =
      obj.recurrence === "daily" || obj.recurrence === "weekly" || obj.recurrence === "monthly"
        ? obj.recurrence
        : "none";
    return {
      title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined,
      dueAt: typeof obj.dueAt === "string" && obj.dueAt.trim() ? obj.dueAt.trim() : undefined,
      hasExplicitTime: obj.hasExplicitTime === true,
      recurrence,
    };
  } catch {
    return null;
  }
}

/**
 * Deep analysis of a reminder request that may be CONDITIONAL or a RANGE
 * ("remind me to revise daily until my exam is over", "every morning this week",
 * "for the next 10 days at 9pm").
 *
 * Returns one of:
 *  - { kind: "single" }  — a normal one-off (delegate to the simple flow).
 *  - { kind: "series" }  — a bounded recurring request with resolved start/end.
 *  - { kind: "clarify" } — the model is NOT confident (missing dates/times); it
 *      asks ONE natural question. The caller asks the user and re-analyzes.
 *
 * Best-effort: returns null on any failure so the caller falls back to the
 * deterministic create flow. The LLM interprets; the caller VALIDATES (dates via
 * isValidFutureIsoDate, count via the series cap) before acting.
 */
export type ReminderAnalysis =
  | { kind: "single" }
  | {
      kind: "series";
      title: string;
      seriesStart: string; // ISO of first occurrence (with the clock time baked in)
      seriesEnd: string; // ISO of the last day to include
      recurrence: "daily" | "weekly" | "monthly";
    }
  | { kind: "clarify"; question: string };

export async function analyzeReminderRequest(
  message: string,
  opts: { timeZone?: string; nowMs?: number; priorContext?: string; timeoutMs?: number } = {},
): Promise<ReminderAnalysis | null> {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) return null;
  const model = process.env.NVIDIA_NIM_MODEL ?? NIM_DEFAULT_MODEL;
  const now = opts.nowMs ? new Date(opts.nowMs) : new Date();
  const tz = opts.timeZone ?? "UTC";

  let anchor: string;
  try {
    anchor = new Intl.DateTimeFormat("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz,
    }).format(now);
  } catch {
    anchor = now.toISOString();
  }

  const system =
    `You analyse a reminder request and reply with STRICT JSON only. ` +
    `Current date & time: ${anchor} (timezone ${tz}). ` +
    `Decide the kind:\n` +
    `- "single": an ordinary one-off or simple recurring reminder with a clear time → {"kind":"single"}.\n` +
    `- "series": a BOUNDED repeating reminder where you can resolve BOTH ends and a time ` +
    `(e.g. "every morning until friday", "daily for 10 days at 9pm") → ` +
    `{"kind":"series","title":string,"seriesStart":ISO-8601,"seriesEnd":ISO-8601,"recurrence":"daily"|"weekly"|"monthly"}. ` +
    `seriesStart includes the clock time; seriesEnd is the last day to include.\n` +
    `- "clarify": the request is conditional or a range but you are MISSING the start, end, or time ` +
    `(e.g. "remind me daily until my exam is over" — you don't know the exam dates) → ` +
    `{"kind":"clarify","question":string}. Ask ONE short, friendly question for exactly what's missing.\n` +
    `Resolve all relative dates against the current date. Never invent dates you don't have — ask instead. ` +
    `Title is the action only, no date/time words.`;

  const userContent = opts.priorContext
    ? `Earlier request: ${opts.priorContext}\nUser's answer: ${message}`
    : message;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 9000);
    const res = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 260,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const obj = JSON.parse(extractJsonObject(data.choices?.[0]?.message?.content ?? "")) as Record<string, unknown>;
    const kind = obj.kind;
    if (kind === "single") return { kind: "single" };
    if (kind === "clarify" && typeof obj.question === "string" && obj.question.trim()) {
      return { kind: "clarify", question: obj.question.trim() };
    }
    if (
      kind === "series" &&
      typeof obj.title === "string" &&
      typeof obj.seriesStart === "string" &&
      typeof obj.seriesEnd === "string" &&
      (obj.recurrence === "daily" || obj.recurrence === "weekly" || obj.recurrence === "monthly")
    ) {
      return {
        kind: "series",
        title: obj.title.trim() || "Reminder",
        seriesStart: obj.seriesStart,
        seriesEnd: obj.seriesEnd,
        recurrence: obj.recurrence,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found.");
  return text.slice(start, end + 1);
}

export function safeAgentResponse(
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
    return { ...parsed, reply: polishReply(parsed.reply) };
  } catch {
    // Strip any code fences or JSON blobs (privacy: never leak full LLM JSON).
    const safe = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\{[\s\S]{40,}\}/g, "")
      .trim();
    // If the LLM produced any reasonable plain text, use it
    if (safe.length > 5 && safe.length < 600) {
      return { reply: polishReply(safe), action: { type: "unknown" } };
    }
    // Otherwise produce a helpful context-aware summary — NEVER a generic error
    const reply = reminders
      ? buildHelpfulFallback(reminders, timeZone)
      : "I'm here to help with your reminders and tasks. Tell me what you'd like — list, create, complete, or update any reminder.";
    return { reply, action: { type: "unknown" } };
  }
}

// ─── Reply polish ─────────────────────────────────────────────────────────────
// Lightweight post-processor that fixes the most common LLM formatting failures
// without touching well-structured replies. Applied after safeAgentResponse so
// even when the LLM ignores the system-prompt formatting rules, the UI still
// receives clean, readable markdown.

export function polishReply(reply: string): string {
  let r = reply.trim();

  // 0. Strip leaked internal Convex IDs that the LLM sometimes parrots from the digest.
  //    Pattern: " | id=<alphanumeric>" — never belongs in a user-facing reply.
  r = r.replace(/\s*\|\s*id=[a-zA-Z0-9_-]+/g, "");

  // 1. Collapse 3+ consecutive blank lines to a single blank line.
  r = r.replace(/\n{3,}/g, "\n\n");

  // 2. Convert inline numbered runs  "1) X  2) Y  3) Z"  to a newline list.
  //    Matches when the same line contains at least three consecutive N) or N. tokens.
  r = r.replace(
    /^(.*?)(\d+[.)]\s+[^\n]+?)(?:\s{2,}|\s*[,;]\s*)(\d+[.)]\s+[^\n]+?)(?:\s{2,}|\s*[,;]\s*)(\d+[.)].+)$/gm,
    (_, pre, a, b, c) => {
      const prefix = pre.trim() ? `${pre.trim()}\n` : "";
      return `${prefix}${a.trim()}\n${b.trim()}\n${c.trim()}`;
    },
  );

  // 3. Convert "Section: item1, item2, item3" into a bold header + list when
  //    there are 3+ comma-separated items after the colon.
  r = r.replace(
    /^([A-Z][^:\n]{1,30}):\s+([^\n]+,(?:[^\n]+,)+[^\n]+)$/gm,
    (_, label, body) => {
      const items = body.split(/,\s*/).map((s: string) => s.trim()).filter(Boolean);
      if (items.length < 3) return `**${label}:**\n${body}`;
      const list = items.map((item: string, i: number) => `${i + 1}. ${item}`).join("\n");
      return `**${label} (${items.length}):**\n${list}`;
    },
  );

  // 4. Convert "Section (N):\n" or "Section:\n" followed by plain sentences
  //    (no existing bullet/number markers) to bolded headers so they stand out.
  r = r.replace(/^([A-Z][^:\n]{1,30}(?:\s*\(\d+\))?):\s*$/gm, "**$1:**");

  // 5. Trim trailing whitespace from each line.
  r = r.split("\n").map((line) => line.trimEnd()).join("\n");

  return r.trim();
}

