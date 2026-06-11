import type { ReminderAgentResponse } from "./types";
import { type ReminderItem } from "@repo/reminder";
import { buildHelpfulFallback } from "./format";

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

