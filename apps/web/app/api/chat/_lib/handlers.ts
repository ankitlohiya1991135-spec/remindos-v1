// Per-intent fast-path handlers extracted from the chat POST route.
// Each returns a ReminderAgentResponse to short-circuit, or null to fall through
// to the next handler (preserving the original sequential control flow).
import {
  looksLikeBulkIntent, looksLikeMarkDoneIntent, looksLikeDeleteIntent,
  looksLikeRescheduleIntent, looksLikeEditIntent, looksLikeSnoozeIntent,
  findReminderByFuzzyMatch,
  type ReminderItem, type TaskItem, type LifeDomain,
} from "@repo/reminder";
import type { ReplyContextPayload } from "../../../../lib/chat-reply-context";
import type { ReminderAgentAction, ReminderAgentResponse } from "./types";
import { formatDueInUserZone } from "./format";
import { parseDateTimeFromInput, isValidFutureIsoDate } from "./datetime";
import {
  resolveByOrdinal, extractTargetFromMarkDone, extractTargetFromDelete, extractTargetFromReschedule,
  titleIncludesTarget, targetHasMeaningfulContent, resolveTargetFromHistory, PRONOUN_TARGETS,
  extractBulkOperation, extractBulkTargets, extractSnoozeDelayMinutes, extractTargetFromSnooze,
  extractEditField, extractNewValueFromEdit, extractTargetFromEdit, extractPriorityFromEdit,
  extractDomainFromEdit, extractRecurrenceFromEdit, extractTaskLinkIntent,
} from "./extract";
import { saveMessageServerSide } from "./data";

export interface ChatRequestBody {
  message?: string;
  reminders?: ReminderItem[];
  tasks?: TaskItem[];
  timeZone?: string;
  replyContext?: ReplyContextPayload;
  pendingAction?: {
    type: "mark_done" | "delete_reminder" | "create_reminder" | "edit_reminder" | "mark_task_done" | "delete_task" | "edit_task";
    targetId?: string; targetTitle?: string; targetIds?: string[];
    title?: string; dueAt?: string; priority?: number; domain?: string; recurrence?: string;
    newTitle?: string; newNotes?: string; newPriority?: number;
    newDomain?: LifeDomain | null; newRecurrence?: "none" | "daily" | "weekly" | "monthly"; newLinkedTaskId?: string | null;
  };
  recentListedIds?: string[];
}

export interface ChatContext {
  userId: string;
  message: string;
  effectiveMessage: string;
  reminders: ReminderItem[];
  tasks: TaskItem[];
  timeZone: string | undefined;
  history: Array<{ role: string; content: string }>;
  body: ChatRequestBody;
}

export async function tryBulk(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, timeZone } = ctx;
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
        return r;
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
      return r;
    }
    // op unknown — fall through to LLM
  }

  return null;
}

export async function tryMarkDone(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, timeZone, history, body } = ctx;
  // ─── Gap 2: deterministic mark-done fast path ──────────────────────────────
  if (looksLikeMarkDoneIntent(message)) {
    const ordinalTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    if (ordinalTarget) {
      const r: ReminderAgentResponse = {
        reply: `Are you sure you want to mark "${ordinalTarget.title}" — ${formatDueInUserZone(ordinalTarget.dueAt, timeZone)} as done — tap Done on the card below.`,
        action: { type: "mark_done", preview: true, targetId: ordinalTarget.id, targetTitle: ordinalTarget.title },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return r;
    }
    const rawTarget = extractTargetFromMarkDone(message);
    if (rawTarget.length >= 2) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && titleIncludesTarget(r.title, rawTarget),
      );
      if (matches.length === 1) {
        const target = matches[0]!;
        const r: ReminderAgentResponse = {
          reply: `Are you sure you want to mark "${target.title}" — ${formatDueInUserZone(target.dueAt, timeZone)} as done — tap Done on the card below.`,
          action: { type: "mark_done", preview: true, targetId: target.id, targetTitle: target.title },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}" at ${formatDueInUserZone(r.dueAt, timeZone)}`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify", pendingOp: "mark_done", candidateIds: matches.map((m) => m.id) },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      // Zero matches — fall through to LLM
    }
    // Phase 1C: pronoun resolution — "mark it done" with no extractable title
    if (rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase())) {
      const pronounTarget = resolveTargetFromHistory(history, reminders.filter((r) => r.status === "pending"));
      if (pronounTarget) {
        const r: ReminderAgentResponse = {
          reply: `Are you sure you want to mark "${pronounTarget.title}" — ${formatDueInUserZone(pronounTarget.dueAt, timeZone)} as done — tap Done on the card below.`,
          action: { type: "mark_done", preview: true, targetId: pronounTarget.id, targetTitle: pronounTarget.title },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    }
  }

  return null;
}

export async function tryDelete(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, timeZone, history, body } = ctx;
  // ─── Gap 2: deterministic delete fast path ─────────────────────────────────
  if (looksLikeDeleteIntent(message)) {
    const ordinalTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    if (ordinalTarget) {
      const r: ReminderAgentResponse = {
        reply: `Are you sure you want to delete "${ordinalTarget.title}" — ${formatDueInUserZone(ordinalTarget.dueAt, timeZone)} — tap Delete on the card below.`,
        action: { type: "delete_reminder", preview: true, targetId: ordinalTarget.id, targetTitle: ordinalTarget.title },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return r;
    }
    const rawTarget = extractTargetFromDelete(message);
    if (rawTarget.length >= 2) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && titleIncludesTarget(r.title, rawTarget),
      );
      if (matches.length === 1) {
        const target = matches[0]!;
        const r: ReminderAgentResponse = {
          reply: `Are you sure you want to delete "${target.title}" — ${formatDueInUserZone(target.dueAt, timeZone)} — tap Delete on the card below.`,
          action: { type: "delete_reminder", preview: true, targetId: target.id, targetTitle: target.title },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}" at ${formatDueInUserZone(r.dueAt, timeZone)}`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify", pendingOp: "delete", candidateIds: matches.map((m) => m.id) },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      // Zero matches — fall through to LLM
    }
    // Phase 1C: pronoun resolution — "delete it" / "remove that"
    if (rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase())) {
      const pronounTarget = resolveTargetFromHistory(history, reminders.filter((r) => r.status === "pending"));
      if (pronounTarget) {
        const r: ReminderAgentResponse = {
          reply: `Are you sure you want to delete "${pronounTarget.title}" — ${formatDueInUserZone(pronounTarget.dueAt, timeZone)} — tap Delete on the card below.`,
          action: { type: "delete_reminder", preview: true, targetId: pronounTarget.id, targetTitle: pronounTarget.title },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    }
  }

  return null;
}

export async function tryReschedule(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, timeZone, history, body } = ctx;
  // ─── Reschedule fast path ─────────────────────────────────────────────────
  if (looksLikeRescheduleIntent(message)) {
    const parsed = parseDateTimeFromInput(message, timeZone);
    const validDueAt = parsed && isValidFutureIsoDate(parsed) ? parsed : undefined;

    // Resolve WHICH reminder first, so an under-specified change ("change my
    // doctor reminder time to this") still opens the card for the user to set the
    // time — instead of a dead-end text prompt.
    const ordinalTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    const rawTarget = extractTargetFromReschedule(message);
    // A target is a context reference (resolve from history) when it's empty, a
    // bare pronoun, OR a filler-only fragment like "its time" — an extraction
    // artifact that must NOT be mistaken for a real reminder title.
    const isPronoun =
      !rawTarget ||
      rawTarget.length < 2 ||
      PRONOUN_TARGETS.has(rawTarget.toLowerCase()) ||
      !targetHasMeaningfulContent(rawTarget);
    let target: ReminderItem | undefined = ordinalTarget ?? undefined;

    if (!target && !isPronoun) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && titleIncludesTarget(r.title, rawTarget),
      );
      if (matches.length === 1) target = matches[0];
      // Multiple exact matches → ask which one, carrying the time forward.
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}" at ${formatDueInUserZone(r.dueAt, timeZone)}`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify", pendingOp: "reschedule", candidateIds: matches.map((m) => m.id), ...(validDueAt ? { pendingDueAt: validDueAt } : {}) },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    }

    // Pronoun ("reschedule it to tomorrow") → resolve from the last assistant turn.
    if (!target && isPronoun) {
      target = resolveTargetFromHistory(history, reminders.filter((r) => r.status === "pending"));
    }

    // Fuzzy-match fallback: if exact/partial title match failed, try token overlap.
    if (!target && rawTarget) {
      const fuzzyId = findReminderByFuzzyMatch(rawTarget, reminders);
      if (fuzzyId) target = reminders.find((r) => r.id === fuzzyId);
    }

    if (target) {
      // Modification of a specific reminder → show the reschedule CARD. Prefill the
      // new time when we parsed one; otherwise the card opens at the reminder's
      // current time for the user to pick. The system never commits — Save does.
      const r: ReminderAgentResponse = {
        reply: validDueAt
          ? `here's "${target.title}" — review the new time (${formatDueInUserZone(validDueAt, timeZone)}) and tap save.`
          : `here's "${target.title}" — pick the new time on the card and tap save.`,
        action: {
          type: "reschedule_reminder",
          targetId: target.id,
          targetTitle: target.title,
          ...(validDueAt ? { dueAt: validDueAt } : {}),
          preview: true,
        },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return r;
    }

    // No specific reminder found — ask which one.
    // Use pendingOp: "reschedule" so the client treats the reply as a
    // reschedule disambiguation, NOT as a create-reminder wizard trigger.
    const pendingReminders = reminders.filter((r) => r.status === "pending");
    const sample = pendingReminders.slice(0, 3).map((r) => `"${r.title}"`).join(", ");
    const r: ReminderAgentResponse = {
      reply: pendingReminders.length > 0
        ? `Which reminder should I reschedule? You have: ${sample}${pendingReminders.length > 3 ? ` and ${pendingReminders.length - 3} more` : ""}.`
        : "Which reminder should I reschedule? You don't have any pending reminders right now.",
      action: { type: "clarify", pendingOp: "reschedule", ...(validDueAt ? { pendingDueAt: validDueAt } : {}) },
    };
    void saveMessageServerSide(userId, "user", message);
    void saveMessageServerSide(userId, "assistant", r.reply);
    return r;
  }

  return null;
}

export async function tryEdit(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, tasks, history, body } = ctx;
  // ─── Gap 5: edit fast path (title, notes, priority, domain, recurrence, task link) ────
  if (looksLikeEditIntent(message)) {
    const field = extractEditField(message);

    if (!field) {
      const r: ReminderAgentResponse = {
        reply: "What would you like to change — the title, notes, priority, domain, recurrence, or task link?",
        action: { type: "clarify" },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return r;
    }

    // ── Resolve the parsed new value for each field type ──────────────────────
    let resolvedNewValue: string | null = null;        // for title/notes (string)
    let resolvedPriority: number | null = null;        // for priority
    let resolvedDomain: LifeDomain | null | undefined = undefined; // for domain (undefined=not found)
    let resolvedRecurrence: "none"|"daily"|"weekly"|"monthly" | null = null;
    let resolvedTaskLink: { link: false } | { link: true; taskHint: string } | null = null;

    if (field === "title" || field === "notes") {
      resolvedNewValue = extractNewValueFromEdit(message);
      if (!resolvedNewValue) {
        const r: ReminderAgentResponse = {
          reply: `What should the new ${field} be?`,
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    } else if (field === "priority") {
      resolvedPriority = extractPriorityFromEdit(message);
      if (resolvedPriority === null) {
        const r: ReminderAgentResponse = {
          reply: "What priority level? Use 1 (low) to 5 (urgent), or say high, medium, or low.",
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    } else if (field === "domain") {
      resolvedDomain = extractDomainFromEdit(message);
      if (resolvedDomain === undefined) {
        const r: ReminderAgentResponse = {
          reply: "Which domain — health, finance, career, hobby, or fun? (or say 'clear' to remove the domain)",
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    } else if (field === "recurrence") {
      resolvedRecurrence = extractRecurrenceFromEdit(message);
      if (resolvedRecurrence === null) {
        const r: ReminderAgentResponse = {
          reply: "What recurrence — daily, weekly, monthly, or one-time (none)?",
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    } else if (field === "linkedTaskId") {
      resolvedTaskLink = extractTaskLinkIntent(message);
      if (!resolvedTaskLink) {
        const r: ReminderAgentResponse = {
          reply: "Would you like to link this reminder to a task, or unlink it from its current task?",
          action: { type: "clarify" },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      // Linking but task hint provided and no match found → ask which task
      if (resolvedTaskLink.link && resolvedTaskLink.taskHint && tasks.length > 0) {
        const hint = resolvedTaskLink.taskHint.toLowerCase();
        const matched = tasks.find(
          (t) => t.title.toLowerCase().includes(hint) || hint.includes(t.title.toLowerCase()),
        );
        if (!matched) {
          const taskNames = tasks.slice(0, 4).map((t) => `"${t.title}"`).join(", ");
          const r: ReminderAgentResponse = {
            reply: `I couldn't find a task named "${resolvedTaskLink.taskHint}". Your tasks: ${taskNames}. Which one should I link to?`,
            action: { type: "clarify" },
          };
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return r;
        }
      }
    }

    // ── Build the action payload for pending_confirm ───────────────────────────
    function buildEditActionPayload(): Partial<ReminderAgentAction> {
      if (field === "title") return { newTitle: resolvedNewValue! };
      if (field === "notes") return { newNotes: resolvedNewValue! };
      if (field === "priority") return { newPriority: resolvedPriority! };
      if (field === "domain") return { newDomain: resolvedDomain as LifeDomain | null };
      if (field === "recurrence") return { newRecurrence: resolvedRecurrence! };
      if (field === "linkedTaskId") {
        if (!resolvedTaskLink) return {};
        if (!resolvedTaskLink.link) return { newLinkedTaskId: null };
        // Linking: try to resolve task ID from hint
        if (resolvedTaskLink.taskHint) {
          const hint = resolvedTaskLink.taskHint.toLowerCase();
          const matched = tasks.find((t) =>
            t.title.toLowerCase().includes(hint) || hint.includes(t.title.toLowerCase()),
          );
          if (matched) return { newLinkedTaskId: matched.id };
        }
        return {}; // will fall through to LLM if task not found
      }
      return {};
    }

    // ── Build human-readable preview for confirmation prompt ─────────────────
    function buildEditPreview(): string {
      if (field === "title" && resolvedNewValue) {
        const p = resolvedNewValue.length > 40 ? `${resolvedNewValue.slice(0, 40)}…` : resolvedNewValue;
        return `rename it to "${p}"`;
      }
      if (field === "notes" && resolvedNewValue) {
        const p = resolvedNewValue.length > 40 ? `${resolvedNewValue.slice(0, 40)}…` : resolvedNewValue;
        return `set notes to "${p}"`;
      }
      if (field === "priority" && resolvedPriority !== null) {
        const labels: Record<number, string> = { 1: "low (1★)", 2: "2★", 3: "medium (3★)", 4: "high (4★)", 5: "urgent (5★)" };
        return `set priority to ${labels[resolvedPriority] ?? `${resolvedPriority}★`}`;
      }
      if (field === "domain") {
        return resolvedDomain === null ? "clear the domain tag" : `set domain to "${resolvedDomain}"`;
      }
      if (field === "recurrence") {
        const labels: Record<string, string> = { none: "one-time (no recurrence)", daily: "daily", weekly: "weekly", monthly: "monthly" };
        return `set recurrence to ${labels[resolvedRecurrence!] ?? resolvedRecurrence}`;
      }
      if (field === "linkedTaskId" && resolvedTaskLink) {
        if (!resolvedTaskLink.link) return "unlink from its task";
        const payload = buildEditActionPayload();
        if (payload.newLinkedTaskId) {
          const t = tasks.find((t) => t.id === payload.newLinkedTaskId);
          return `link to task "${t?.title ?? payload.newLinkedTaskId}"`;
        }
        return `link to a task`;
      }
      return `update ${field}`;
    }

    const ordinalEditTarget = resolveByOrdinal(message, reminders, body.recentListedIds);
    if (ordinalEditTarget) {
      const payload = buildEditActionPayload();
      const preview = buildEditPreview();
      const r: ReminderAgentResponse = {
        reply: `here's "${ordinalEditTarget.title}" — review the change (${preview}) and tap save.`,
        action: {
          type: "edit_reminder",
          preview: true,
          targetId: ordinalEditTarget.id,
          targetTitle: ordinalEditTarget.title,
          ...payload,
        },
      };
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return r;
    }

    const rawTarget = extractTargetFromEdit(message);
    const isPronoun = !rawTarget || rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase());

    if (!isPronoun) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && titleIncludesTarget(r.title, rawTarget),
      );
      if (matches.length === 1) {
        const target = matches[0]!;
        const payload = buildEditActionPayload();
        const preview = buildEditPreview();
        const r: ReminderAgentResponse = {
          reply: `here's "${target.title}" — review the change (${preview}) and tap save.`,
          action: {
            type: "edit_reminder",
            preview: true,
            targetId: target.id,
            targetTitle: target.title,
            ...payload,
          },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}"`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: {
            type: "clarify",
            pendingOp: "edit",
            candidateIds: matches.map((m) => m.id),
            pendingField: field,
            pendingValue: resolvedNewValue ?? String(resolvedPriority ?? resolvedDomain ?? resolvedRecurrence ?? ""),
          },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
      // Zero matches — fall through to LLM
    }
    // Phase 1C: pronoun resolution for edit — "rename it" / "change its priority"
    if (isPronoun) {
      const pronounTarget = resolveTargetFromHistory(history, reminders.filter((r) => r.status === "pending"));
      if (pronounTarget) {
        const payload = buildEditActionPayload();
        const preview = buildEditPreview();
        const r: ReminderAgentResponse = {
          reply: `here's "${pronounTarget.title}" — review the change (${preview}) and tap save.`,
          action: {
            type: "edit_reminder",
            preview: true,
            targetId: pronounTarget.id,
            targetTitle: pronounTarget.title,
            ...payload,
          },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    }
    // Pronoun or no target — fall through to LLM for disambiguation
  }

  return null;
}

export async function trySnoozeRecovery(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, timeZone, history } = ctx;
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
          (r) => r.status === "pending" && titleIncludesTarget(r.title, rawTarget),
        );
        const target = matches.length === 1 ? matches[0] : (matches[0] ?? undefined);
        if (target) {
          const newDueAt = new Date(Date.now() + recoveredDelay * 60_000).toISOString();
          const label =
            recoveredDelay >= 60
              ? `${Math.round(recoveredDelay / 60)} hour${Math.round(recoveredDelay / 60) !== 1 ? "s" : ""}`
              : `${recoveredDelay} minute${recoveredDelay !== 1 ? "s" : ""}`;
          const r: ReminderAgentResponse = {
            reply: `here's "${target.title}" — review the snooze (${label}, ${formatDueInUserZone(newDueAt, timeZone)}) and tap save.`,
            action: { type: "snooze_reminder", preview: true, targetId: target.id, targetTitle: target.title, delayMinutes: recoveredDelay },
          };
          void saveMessageServerSide(userId, "user", effectiveMessage);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return r;
        }
      }
    }
  }

  return null;
}

export async function trySnooze(ctx: ChatContext): Promise<ReminderAgentResponse | null> {
  const { userId, message, effectiveMessage, reminders, timeZone, history, body } = ctx;
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
      return r;
    }

    // Gap 7: ordinal resolution ("snooze the second one by 30 min")
    const ordinalSnoozeTarget = resolveByOrdinal(message, reminders, body.recentListedIds);

    const rawTarget = extractTargetFromSnooze(message);
    const isPronoun = !rawTarget || rawTarget.length < 2 || PRONOUN_TARGETS.has(rawTarget.toLowerCase());
    let target: ReminderItem | undefined = ordinalSnoozeTarget ?? undefined;

    if (!target && !isPronoun) {
      const matches = reminders.filter(
        (r) => r.status === "pending" && titleIncludesTarget(r.title, rawTarget),
      );
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length > 1) {
        const sample = matches.slice(0, 2).map((r) => `"${r.title}"`);
        const r: ReminderAgentResponse = {
          reply: `Which one do you mean — ${sample.join(" or ")}?`,
          action: { type: "clarify", pendingOp: "snooze", candidateIds: matches.map((m) => m.id), pendingDelayMinutes: delayMinutes },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", r.reply);
        return r;
      }
    }

    // Phase 1C: pronoun resolution — "snooze it" → reminder from last assistant message
    if (!target && isPronoun) {
      target = resolveTargetFromHistory(history, reminders.filter((r) => r.status === "pending"));
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
      return r;
    }

    const newDueAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    const label =
      delayMinutes >= 60
        ? `${Math.round(delayMinutes / 60)} hour${Math.round(delayMinutes / 60) !== 1 ? "s" : ""}`
        : `${delayMinutes} minute${delayMinutes !== 1 ? "s" : ""}`;
    const r: ReminderAgentResponse = {
      reply: `Snoozed "${target.title}" — I'll remind you again in ${label} (${formatDueInUserZone(newDueAt, timeZone)}).`,
      action: { type: "snooze_reminder", preview: true, targetId: target.id, targetTitle: target.title, delayMinutes },
    };
    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", r.reply);
    return r;
  }

  return null;
}
