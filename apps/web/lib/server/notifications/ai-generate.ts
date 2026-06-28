/**
 * notifications/ai-generate.ts — LLM-personalized smart nudge copy.
 *
 * Replaces the hardcoded/random templates in engine.ts for SMART NUDGES ONLY
 * (morning_launch, just_start, time_anchor, win_celebration, overwhelm_rescue,
 * evening_soft_close, accountability_nudge, streak_celebration, all_clear).
 *
 * Does NOT touch due-reminder / "X overdue reminders" pushes — those are sent
 * elsewhere (use-due-notifications.ts, the reminder due-time cron) and never
 * call this module.
 *
 * Best-effort, same contract as chat/_lib/nim.ts: returns null on ANY failure
 * (no API key, timeout, bad JSON, validator rejection) so the caller falls
 * back to the deterministic template engine. The LLM never bypasses the
 * anti-surveillance validator — it is gated through safeNotification() exactly
 * like template copy.
 */

import { safeNotification } from "./validate";

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NIM_DEFAULT_MODEL = "mistralai/mistral-medium-3.5-128b";

const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 120;

export type NudgeMoment =
  | "morning_launch"
  | "just_start"
  | "time_anchor"
  | "win_celebration"
  | "overwhelm_rescue"
  | "evening_soft_close"
  | "accountability_nudge"
  | "streak_celebration"
  | "all_clear";

const MOMENT_HINT: Record<NudgeMoment, string> = {
  morning_launch: "Daily Reset / Planning — start of the user's day, help them land on ONE focus instead of the whole list.",
  just_start: "Focus / AI Suggestion — user has something pending they haven't started; lower the activation barrier.",
  time_anchor: "Deadline — a time-bound item is coming up soon; surface it without alarm.",
  win_celebration: "Goal Progress — the user just completed something; celebrate it.",
  overwhelm_rescue: "Productivity Insight — overdue load is genuinely heavy; reassure and shrink the visible ask to one thing.",
  evening_soft_close: "Daily Reset — end of day wind-down; affirm what happened, release the rest.",
  accountability_nudge: "Missed Opportunity — backlog has grown sizable; name it plainly without guilt.",
  streak_celebration: "Habit / Goal Progress — celebrate a genuine multi-day consistency streak.",
  all_clear: "Daily Reset — nothing pending; warm, low-key check-in.",
};

const SYSTEM_PROMPT = `You are the notification engine for PersonalOS.

Your job is to generate highly engaging push notifications that encourage users to open the app and take action.

The notification should feel like a smart life assistant, not a task manager.

Rules:

1. Never sound robotic.
2. Never simply list tasks.
3. Create curiosity.
4. Focus on outcomes, not reminders.
5. Use simple language.
6. Maximum 2 short sentences.
7. Maximum 80 characters for title.
8. Maximum 120 characters for body.
9. Make the user feel they are missing something important.
10. Be positive and motivating, not fear-based.
11. Occasionally use emojis, but never more than 2.
12. Sound like a personal coach, chief of staff, or second brain.
13. Every notification should make the user think:
   "Let me quickly check."

Generate notifications in this JSON format:

{
  "title": "",
  "body": "",
  "reason": ""
}

The "reason" field explains internally why this notification should increase engagement.

Notification categories:
- Motivation
- Focus
- Deadline
- Habit
- Goal Progress
- Planning
- Productivity Insight
- AI Suggestion
- Missed Opportunity
- Daily Reset

Avoid:
- "Don't forget..."
- "Reminder..."
- "You have X tasks pending..."
- Generic productivity clichés

Reply with ONLY the JSON object, nothing else.`;

export interface NudgeAiContext {
  moment: NudgeMoment;
  displayName?: string | null;
  pendingCount: number;
  overdueCount: number;
  doneToday: number;
  streakDays: number;
  topDomain?: string | null;
  nextDueTitle?: string | null;
  minutesUntilDue?: number | null;
  focusTaskTitle?: string | null;
  completedTaskTitle?: string | null;
  localHour: number;
  /** Only pass when genuinely available — never fabricate. */
  productivityScoreNote?: string | null;
}

export type AiCopy = { title: string; body: string };

function buildUserContext(ctx: NudgeAiContext): string {
  const facts: Record<string, unknown> = {
    category_hint: MOMENT_HINT[ctx.moment],
    displayName: ctx.displayName ?? undefined,
    pendingCount: ctx.pendingCount,
    overdueCount: ctx.overdueCount,
    doneToday: ctx.doneToday,
    streakDays: ctx.streakDays,
    topDomain: ctx.topDomain ?? undefined,
    nextDueTitle: ctx.nextDueTitle ?? undefined,
    minutesUntilDue: ctx.minutesUntilDue ?? undefined,
    focusTaskTitle: ctx.focusTaskTitle ?? undefined,
    completedTaskTitle: ctx.completedTaskTitle ?? undefined,
    localHour: ctx.localHour,
    productivityInsight: ctx.productivityScoreNote ?? undefined,
  };
  // Strip undefined keys — never let the model see/hallucinate around an
  // explicit "undefined" field; absence should just mean absence.
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined));
  return `Generate one notification for this user context (only reference facts present here — never invent data):\n${JSON.stringify(clean)}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Best-effort AI-personalized copy for a smart-nudge moment. Returns null on
 * any failure so the caller (smart-cron) falls back to the deterministic
 * engine.ts templates — this must never be a hard dependency for sending.
 */
export async function generateAiNudge(
  ctx: NudgeAiContext,
  opts: { timeoutMs?: number } = {},
): Promise<AiCopy | null> {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) return null;
  const model = process.env.NVIDIA_NIM_MODEL ?? NIM_DEFAULT_MODEL;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    const res = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        max_tokens: 200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserContext(ctx) },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const parsed = JSON.parse(content.slice(start, end + 1)) as { title?: unknown; body?: unknown };

    let title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    let body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!title || !body) return null;

    title = truncate(title, MAX_TITLE_CHARS);
    body = truncate(body, MAX_BODY_CHARS);

    // Same anti-surveillance backstop the template engine runs through — the
    // LLM is a copy generator, not an exception to the safety rules.
    const safe = safeNotification(title, body);
    if (!safe.title || !safe.body) return null;
    if (safe.title !== title || safe.body !== body) return null; // validator swapped in a fallback — treat as a miss, let caller use the template engine's own (separately-picked) fallback instead of two different sources colliding.

    return { title: safe.title, body: safe.body };
  } catch {
    return null;
  }
}
