import {
  buildListRemindersReply, rankTasks, analyzeSchedule, classifyReminderIntent,
  inferListScopeFromMessage, filterToday, describeReminderForChat,
  tryGroundedReminderAnswer, findReminderByFuzzyMatch,
  type ReminderItem, type ReminderListScope,
} from "@repo/reminder";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatDueInUserZone(iso: string, timeZone?: string) {
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

export function mapAgentScopeToListScope(scope?: string): ReminderListScope | null {
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

export function formatDecisionReply(reminders: ReminderItem[], timeZone?: string) {
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

export function formatPlanningReply(reminders: ReminderItem[], timeZone?: string) {
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
export function buildHelpfulFallback(reminders: ReminderItem[], timeZone?: string): string {
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

export function fallbackDeterministicReply(message: string, reminders: ReminderItem[], timeZone?: string) {
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


