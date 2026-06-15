/**
 * Prompt intent classifier — the SINGLE source of truth for "what kind of
 * reminder prompt is this?". Replaces the scattered, order-dependent regex
 * checks (which caused the card-vs-answer inconsistency) with one decision:
 *
 *   create → make a new reminder
 *   mutate → change an existing reminder (edit/reschedule/delete/done/snooze) → micro-front-end card
 *   info   → a question about reminders → answer it
 *   other  → anything else → general chat / LLM
 *
 * `classifyPromptDeterministic` is a pure, fully-testable baseline. `classifyPrompt`
 * optionally consults the LLM (which is far better at "is this a change request or
 * a question?") and ALWAYS falls back to the deterministic result on any failure,
 * so classification can never hard-break the chat.
 */
import {
  looksLikeCreateIntent,
  looksLikeRescheduleIntent,
  looksLikeMarkDoneIntent,
  looksLikeDeleteIntent,
  looksLikeEditIntent,
  looksLikeSnoozeIntent,
  looksLikeBulkIntent,
  classifyReminderIntent,
  inferListScopeFromMessage,
  inferDetailQueryAboutReminders,
} from "@repo/reminder";

export type PromptCategory = "create" | "mutate" | "info" | "other";

/**
 * Deterministic classification. Precedence matters: create → mutate → info → other.
 * Uses the SAME intent predicates the route's handlers use, so the category always
 * agrees with which path would actually run.
 */
export function classifyPromptDeterministic(message: string): PromptCategory {
  const m = message.trim();
  if (!m) return "other";

  // Create comes first — "remind me to …" can otherwise look like other intents.
  if (looksLikeCreateIntent(m)) return "create";

  // Mutations → these drive the micro-front-end card.
  if (
    looksLikeRescheduleIntent(m) ||
    looksLikeMarkDoneIntent(m) ||
    looksLikeDeleteIntent(m) ||
    looksLikeEditIntent(m) ||
    looksLikeSnoozeIntent(m) ||
    looksLikeBulkIntent(m)
  ) {
    return "mutate";
  }

  // Questions about reminders.
  const intent = classifyReminderIntent(m);
  if (intent === "list_reminders" || intent === "decision_query" || intent === "planning_query") {
    return "info";
  }
  if (inferDetailQueryAboutReminders(m) || inferListScopeFromMessage(m)) {
    return "info";
  }

  return "other";
}

const VALID: ReadonlySet<string> = new Set(["create", "mutate", "info", "other"]);

/**
 * Ask the LLM to classify the prompt into one category word. Returns null on any
 * problem (no key, network error, timeout, unexpected output) so the caller can
 * fall back to the deterministic classifier. Kept tiny + cheap (1 word out).
 */
async function classifyPromptLLM(message: string): Promise<PromptCategory | null> {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) return null;
  const model = process.env.NVIDIA_NIM_MODEL ?? "mistralai/mistral-medium-3.5-128b";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4,
        messages: [
          {
            role: "system",
            content:
              "Classify the user's message about their reminders into ONE word:\n" +
              "- create: they want to make a NEW reminder\n" +
              "- mutate: they want to CHANGE an existing reminder (edit, reschedule, move, delete, mark done/complete, snooze)\n" +
              "- info: they are ASKING about reminders (list, details, time, what's due/overdue/today)\n" +
              "- other: anything else / general chat\n" +
              "Reply with exactly one word: create, mutate, info, or other.",
          },
          { role: "user", content: message.slice(0, 500) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const word = data.choices?.[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z]/g, "");
    return word && VALID.has(word) ? (word as PromptCategory) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Classify a prompt. Consults the LLM only when `useLlm` is true (default: the
 * CLASSIFY_WITH_LLM env flag), and always falls back to the deterministic result.
 */
export async function classifyPrompt(
  message: string,
  useLlm: boolean = process.env.CLASSIFY_WITH_LLM === "true",
): Promise<PromptCategory> {
  const deterministic = classifyPromptDeterministic(message);
  if (!useLlm) return deterministic;
  const llm = await classifyPromptLLM(message);
  return llm ?? deterministic;
}
