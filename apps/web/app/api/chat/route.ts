import { auth } from "@clerk/nextjs/server";
import { buildLifeOsContextBlock, buildListRemindersReply, classifyReminderIntent, filterToday, findReminderByFuzzyMatch, findRemindersByName, answerNamedReminderQuery, inferListScopeFromMessage, isCompoundReminderQuestion, looksLikeCreateIntent, looksLikeImplicitCreate, filterRemindersByListScope, describeReminderForChat, rankTasks, tryGroundedReminderAnswer, type LifeDomain, type ReminderItem, type TaskItem } from "@repo/reminder";
import { api } from "@repo/db/convex/api";
import { NextResponse } from "next/server";
import { getConvexClient, getAuthedConvexClient } from "../../../lib/server/convex-client";
import {
  buildMessageWithReplyContext,
  type ReplyContextPayload,
} from "../../../lib/chat-reply-context";
import { getChatHistory } from "../../../lib/server/chat-history";

import type { ReminderAgentAction, ReminderAgentResponse } from "./_lib/types";
import { systemPrompt } from "./_lib/prompt";
import { hasExplicitTime, hasTodayHint, hasTomorrowHint, hasDayAfterTomorrowHint, getCalendarDateInTimeZone, addDaysToCalendarDate, calendarDateTimeToIso, parseDateTimeFromInput, parseCalendarDateFromInput, isValidFutureIsoDate, expandRecurringSeries, parseEveryInterval, extractClockTimes, expandByDays } from "./_lib/datetime";
import { formatDueInUserZone, mapAgentScopeToListScope, fallbackDeterministicReply } from "./_lib/format";
import { safeAgentResponse, resolveCreateWithLLM, analyzeReminderRequest, type ReminderAnalysis } from "./_lib/nim";
import { parseLifeDomain, loadRemindersForChat, loadTasksForChat, loadUserWiki, filterRemindersForLLM, saveMessageServerSide, looksLikeConfirmation, findTargetReminder, normalizeClientTimeZone, suggestDomainTime, loadProfileForSuggestion } from "./_lib/data";
import { extractTitleFromCreateInput, extractPriorityFromInput, extractDomainFromInput, extractRecurrenceFromInput, titleIncludesTarget, resolveTargetFromHistory, extractNewValueFromEdit, extractPriorityFromEdit, extractDomainFromEdit, taskGate, looksLikeCreateTaskIntent, looksLikeListTasksIntent, looksLikeMarkTaskDoneIntent, looksLikeDeleteTaskIntent, looksLikeEditTaskIntent, extractTargetFromTaskMessage, extractTargetFromTaskEdit, extractEditTaskField, extractTitleFromTaskInput } from "./_lib/extract";
import { tryBulk, tryMarkDone, tryDelete, tryReschedule, tryEdit, trySnoozeRecovery, trySnooze, type ChatContext } from "./_lib/handlers";
import { classifyPrompt } from "./_lib/classify";

// ─── Constants ────────────────────────────────────────────────────────────────

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "mistralai/mistral-medium-3.5-128b";
const DEFAULT_CHAT_REMINDER_TITLE = "Reminder";
const MAX_HISTORY_TURNS = 10; // last 5 user/assistant pairs — reduced to prevent context bloat

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

/** Cap on how many reminders one "until X"/range request may pre-generate. */
const SERIES_CAP = 60;
/** Cues that a create request is a bounded/conditional range needing deep analysis. */
const RANGE_CUE = /\b(until|till|untill|upto|up to|through|throughout|during|for the next|for \d+\s*(day|days|week|weeks|month|months)|each day until|every day until|till my|until my)\b/i;

/**
 * Turn a smart-create LLM analysis into a chat response, or null to fall back to
 * the ordinary create flow. Handles the "series" (pre-generate occurrences) and
 * "clarify" (ask one question) kinds; "single"/invalid → null.
 */
function buildSmartCreateResponse(
  analysis: ReminderAnalysis | null,
  originalMessage: string,
): ReminderAgentResponse | null {
  if (!analysis) return null;

  if (analysis.kind === "clarify") {
    return {
      reply: analysis.question,
      action: { type: "clarify", clarifyForReminder: { originalMessage } },
    };
  }

  if (analysis.kind === "series") {
    const startMs = new Date(analysis.seriesStart).getTime();
    const endMs = new Date(analysis.seriesEnd).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    const dueAts = expandRecurringSeries(startMs, endMs, analysis.recurrence, SERIES_CAP)
      .filter((ms) => ms > Date.now() - 60_000)
      .map((ms) => new Date(ms).toISOString());
    if (dueAts.length === 0) return null;
    return {
      reply: `Setting up "${analysis.title}" — ${dueAts.length} reminder${dueAts.length !== 1 ? "s" : ""} (${analysis.recurrence}). Tap Save to add them all.`,
      action: { type: "create_reminder_series", title: analysis.title, recurrence: analysis.recurrence, seriesDueAts: dueAts },
    };
  }

  return null;
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
      type: "mark_done" | "delete_reminder" | "create_reminder" | "edit_reminder" | "mark_task_done" | "delete_task" | "edit_task";
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
      newPriority?: number;
      newDomain?: LifeDomain | null;
      newRecurrence?: "none" | "daily" | "weekly" | "monthly";
      newLinkedTaskId?: string | null;
    };
    recentListedIds?: string[];
    /** Echoed back when the previous turn asked one smart-create clarifying question. */
    pendingClarify?: { originalMessage: string };
    /** Reminder ID of the most recently created reminder — enables conversational edit/cancel. */
    lastCreatedId?: string;
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

    // Edit confirmation — any edit field
    if (pendingType === "edit_reminder") {
      const pa = body.pendingAction ?? {};
      const hasEditPayload =
        pa.newTitle || pa.newNotes !== undefined ||
        pa.newPriority !== undefined || pa.newDomain !== undefined ||
        pa.newRecurrence !== undefined || pa.newLinkedTaskId !== undefined;
      if (hasEditPayload) {
        const editTarget = findTargetReminder(reminders, targetId, targetTitle);
        if (editTarget) {
          // Determine a human-readable field label for the reply
          let fieldLabel = "fields";
          if (pa.newTitle !== undefined) fieldLabel = "title";
          else if (pa.newNotes !== undefined) fieldLabel = "notes";
          else if (pa.newPriority !== undefined) fieldLabel = "priority";
          else if (pa.newDomain !== undefined) fieldLabel = "domain";
          else if (pa.newRecurrence !== undefined) fieldLabel = "recurrence";
          else if (pa.newLinkedTaskId !== undefined) fieldLabel = pa.newLinkedTaskId === null ? "task link (unlinked)" : "task link";
          const reply = `Done — updated the ${fieldLabel} of "${editTarget.title}".`;
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", reply);
          return NextResponse.json({
            reply,
            action: {
              type: "edit_reminder",
              targetId: editTarget.id,
              targetTitle: editTarget.title,
              ...(pa.newTitle !== undefined ? { newTitle: pa.newTitle } : {}),
              ...(pa.newNotes !== undefined ? { newNotes: pa.newNotes } : {}),
              ...(pa.newPriority !== undefined ? { newPriority: pa.newPriority } : {}),
              ...(pa.newDomain !== undefined ? { newDomain: pa.newDomain } : {}),
              ...(pa.newRecurrence !== undefined ? { newRecurrence: pa.newRecurrence } : {}),
              ...(pa.newLinkedTaskId !== undefined ? { newLinkedTaskId: pa.newLinkedTaskId } : {}),
            },
          } satisfies ReminderAgentResponse);
        }
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
    // ─── Task confirmation handlers ────────────────────────────────────────────
    if (pendingType === "mark_task_done") {
      const target = tasks.find((t) =>
        (targetId && t.id === targetId) ||
        (targetTitle && titleIncludesTarget(t.title, targetTitle))
      );
      if (target) {
        const reply = `Done — task "${target.title}" marked as complete.`;
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", reply);
        return NextResponse.json({
          reply,
          action: { type: "mark_task_done", targetId: target.id, targetTitle: target.title },
        } satisfies ReminderAgentResponse);
      }
      const reply = "I couldn't find that task — it may have already been updated.";
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({ reply, action: { type: "unknown" } } satisfies ReminderAgentResponse);
    }

    if (pendingType === "delete_task") {
      const target = tasks.find((t) =>
        (targetId && t.id === targetId) ||
        (targetTitle && titleIncludesTarget(t.title, targetTitle))
      );
      if (target) {
        const linkedCount = reminders.filter((r) => r.linkedTaskId === target.id).length;
        const suffix = linkedCount > 0
          ? ` (${linkedCount} linked reminder${linkedCount !== 1 ? "s" : ""} unlinked)`
          : "";
        const reply = `Done — task "${target.title}" deleted${suffix}.`;
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", reply);
        return NextResponse.json({
          reply,
          action: { type: "delete_task", targetId: target.id, targetTitle: target.title },
        } satisfies ReminderAgentResponse);
      }
      const reply = "I couldn't find that task — it may have already been deleted.";
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({ reply, action: { type: "unknown" } } satisfies ReminderAgentResponse);
    }

    if (pendingType === "edit_task") {
      const pa = body.pendingAction ?? {};
      const hasEditPayload =
        pa.newTitle || pa.newNotes !== undefined ||
        pa.newPriority !== undefined || pa.newDomain !== undefined;
      if (hasEditPayload) {
        const target = tasks.find((t) =>
          (targetId && t.id === targetId) ||
          (targetTitle && titleIncludesTarget(t.title, targetTitle))
        );
        if (target) {
          let fieldLabel = "fields";
          if (pa.newTitle !== undefined) fieldLabel = "title";
          else if (pa.newNotes !== undefined) fieldLabel = "notes";
          else if (pa.newPriority !== undefined) fieldLabel = "priority";
          else if (pa.newDomain !== undefined) fieldLabel = pa.newDomain === null ? "domain (cleared)" : "domain";
          const reply = `Done — updated the ${fieldLabel} of task "${target.title}".`;
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", reply);
          return NextResponse.json({
            reply,
            action: {
              type: "edit_task",
              targetId: target.id,
              targetTitle: target.title,
              ...(pa.newTitle !== undefined ? { newTitle: pa.newTitle } : {}),
              ...(pa.newNotes !== undefined ? { newNotes: pa.newNotes } : {}),
              ...(pa.newPriority !== undefined ? { newPriority: pa.newPriority } : {}),
              ...(pa.newDomain !== undefined ? { newDomain: pa.newDomain } : {}),
            },
          } satisfies ReminderAgentResponse);
        }
      }
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

  // ─── Task CRUD fast paths ──────────────────────────────────────────────────
  // Gate: only enter if the message explicitly mentions "task" or "tasks".
  // This block runs BEFORE all reminder fast paths so task messages can't be
  // consumed by looksLikeDeleteIntent / looksLikeMarkDoneIntent / looksLikeEditIntent.
  // Reminder guard: if "remind" or "reminder" appears, treat as a reminder message even if
  // "task" also appears (e.g. "create a reminder about my task", "remind me to finish the gym task").
  if (taskGate(message) && !/\bremind(er)?\b/i.test(message)) {
    // ── Create task ──────────────────────────────────────────────────────────
    if (looksLikeCreateTaskIntent(message)) {
      const title = extractTitleFromTaskInput(message) ?? "New Task";
      const priority = extractPriorityFromInput(message);
      const domain = extractDomainFromInput(message);
      const r: ReminderAgentResponse = {
        reply: `Task "${title}" created.`,
        action: {
          type: "create_task",
          title,
          ...(priority !== undefined ? { priority } : {}),
          ...(domain !== undefined ? { domain } : {}),
        },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    // ── List tasks ───────────────────────────────────────────────────────────
    if (looksLikeListTasksIntent(message)) {
      const n = message.toLowerCase();
      const showDone = /\b(done|completed|finished)\b/.test(n);
      const list = showDone
        ? tasks.filter((t) => t.status === "done")
        : tasks.filter((t) => t.status === "pending");
      let reply: string;
      if (list.length === 0) {
        reply = showDone
          ? "You have no completed tasks."
          : "You have no pending tasks yet. Say 'create task <name>' to add one.";
      } else {
        const lines = list.map((t, i) => {
          const priorityBadge = t.priority !== undefined ? ` (p${t.priority})` : "";
          const dueLabel = t.dueAt ? ` — due ${formatDueInUserZone(t.dueAt, timeZone)}` : "";
          return `${i + 1}. ${t.title}${priorityBadge}${dueLabel}`;
        });
        const header = showDone
          ? `**Completed tasks (${list.length}):**`
          : `**Pending tasks (${list.length}):**`;
        reply = `${header}\n${lines.join("\n")}`;
      }
      const r: ReminderAgentResponse = {
        reply,
        action: { type: "list_tasks", scope: showDone ? "done" : "pending" },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", r.reply);
      return NextResponse.json(r);
    }

    // ── Mark task done ───────────────────────────────────────────────────────
    if (looksLikeMarkTaskDoneIntent(message)) {
      const rawTarget = extractTargetFromTaskMessage(message);
      if (rawTarget.length >= 2) {
        const matches = tasks.filter(
          (t) => t.status === "pending" && titleIncludesTarget(t.title, rawTarget),
        );
        if (matches.length === 1) {
          const target = matches[0]!;
          const linkedCount = reminders.filter(
            (r) => r.linkedTaskId === target.id && r.status === "pending",
          ).length;
          const warning = linkedCount > 0
            ? ` It has ${linkedCount} linked reminder${linkedCount !== 1 ? "s" : ""} that will remain active.`
            : "";
          const r: ReminderAgentResponse = {
            reply: `Mark task "${target.title}" as done?${warning} Reply **yes** to confirm.`,
            action: { type: "pending_confirm", pendingType: "mark_task_done", targetId: target.id, targetTitle: target.title },
          };
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
        if (matches.length > 1) {
          const sample = matches.slice(0, 2).map((t) => `"${t.title}"`);
          const r: ReminderAgentResponse = {
            reply: `Which task do you mean — ${sample.join(" or ")}?`,
            action: { type: "clarify" },
          };
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
        // Zero matches — fall through to LLM
      }
    }

    // ── Delete task ──────────────────────────────────────────────────────────
    if (looksLikeDeleteTaskIntent(message)) {
      const rawTarget = extractTargetFromTaskMessage(message);
      if (rawTarget.length >= 2) {
        const matches = tasks.filter((t) => titleIncludesTarget(t.title, rawTarget));
        if (matches.length === 1) {
          const target = matches[0]!;
          const linkedCount = reminders.filter((r) => r.linkedTaskId === target.id).length;
          const warning = linkedCount > 0
            ? ` Deleting it will unlink ${linkedCount} reminder${linkedCount !== 1 ? "s" : ""}.`
            : "";
          const r: ReminderAgentResponse = {
            reply: `Delete task "${target.title}"?${warning} Reply **yes** to confirm.`,
            action: { type: "pending_confirm", pendingType: "delete_task", targetId: target.id, targetTitle: target.title },
          };
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
        if (matches.length > 1) {
          const sample = matches.slice(0, 2).map((t) => `"${t.title}"`);
          const r: ReminderAgentResponse = {
            reply: `Which task do you mean — ${sample.join(" or ")}?`,
            action: { type: "clarify" },
          };
          void saveMessageServerSide(userId, "user", message);
          void saveMessageServerSide(userId, "assistant", r.reply);
          return NextResponse.json(r);
        }
        // Zero matches — fall through to LLM
      }
    }

    // ── Edit task ────────────────────────────────────────────────────────────
    if (looksLikeEditTaskIntent(message)) {
      const field = extractEditTaskField(message);
      if (field) {
        let resolvedNewValue: string | null = null;
        let resolvedPriority: number | null = null;
        let resolvedDomain: LifeDomain | null | undefined = undefined;

        if (field === "title" || field === "notes") {
          resolvedNewValue = extractNewValueFromEdit(message);
          if (!resolvedNewValue) {
            const r: ReminderAgentResponse = {
              reply: `What should the new ${field} be?`,
              action: { type: "clarify" },
            };
            void saveMessageServerSide(userId, "user", message);
            void saveMessageServerSide(userId, "assistant", r.reply);
            return NextResponse.json(r);
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
            return NextResponse.json(r);
          }
        } else if (field === "domain") {
          resolvedDomain = extractDomainFromEdit(message);
          if (resolvedDomain === undefined) {
            const r: ReminderAgentResponse = {
              reply: "Which domain — health, finance, career, hobby, or fun? (or say 'clear' to remove it)",
              action: { type: "clarify" },
            };
            void saveMessageServerSide(userId, "user", message);
            void saveMessageServerSide(userId, "assistant", r.reply);
            return NextResponse.json(r);
          }
        }

        const rawTarget = extractTargetFromTaskEdit(message);
        if (rawTarget.length >= 2) {
          const matches = tasks.filter((t) => titleIncludesTarget(t.title, rawTarget));
          if (matches.length === 1) {
            const target = matches[0]!;
            // Build the payload and a human-readable preview
            const editPayload: Partial<ReminderAgentAction> = {};
            let previewStr = `update ${field}`;
            if (field === "title" && resolvedNewValue) {
              editPayload.newTitle = resolvedNewValue;
              previewStr = `rename to "${resolvedNewValue.slice(0, 40)}"`;
            } else if (field === "notes" && resolvedNewValue !== null) {
              editPayload.newNotes = resolvedNewValue;
              previewStr = `set notes to "${resolvedNewValue.slice(0, 40)}"`;
            } else if (field === "priority" && resolvedPriority !== null) {
              editPayload.newPriority = resolvedPriority;
              const labels: Record<number, string> = { 1: "low (1★)", 2: "2★", 3: "medium (3★)", 4: "high (4★)", 5: "urgent (5★)" };
              previewStr = `set priority to ${labels[resolvedPriority] ?? `${resolvedPriority}★`}`;
            } else if (field === "domain") {
              editPayload.newDomain = resolvedDomain as LifeDomain | null;
              previewStr = resolvedDomain === null ? "clear the domain tag" : `set domain to "${resolvedDomain}"`;
            }
            const r: ReminderAgentResponse = {
              reply: `Update task "${target.title}" — ${previewStr}? Reply **yes** to confirm.`,
              action: {
                type: "pending_confirm",
                pendingType: "edit_task",
                targetId: target.id,
                targetTitle: target.title,
                ...editPayload,
              },
            };
            void saveMessageServerSide(userId, "user", message);
            void saveMessageServerSide(userId, "assistant", r.reply);
            return NextResponse.json(r);
          }
          if (matches.length > 1) {
            const sample = matches.slice(0, 2).map((t) => `"${t.title}"`);
            const r: ReminderAgentResponse = {
              reply: `Which task do you mean — ${sample.join(" or ")}?`,
              action: { type: "clarify" },
            };
            void saveMessageServerSide(userId, "user", message);
            void saveMessageServerSide(userId, "assistant", r.reply);
            return NextResponse.json(r);
          }
          // Zero matches — fall through to LLM
        }
      }
    }
    // If taskGate matched but no task classifier matched, fall through to reminder paths / LLM
  }

  // ── Conversational edit/cancel: "Actually make it 6 PM" / "cancel that" ────
  //    Fires when the user's last turn created a reminder and they're correcting it.
  //    Requires the client to send back lastCreatedId for the just-created reminder.
  if (body.lastCreatedId) {
    const n = message.toLowerCase();
    const isCancel = /\b(cancel|delete|remove|forget it|never mind|nevermind|scrap it|ignore that|skip that|don'?t (create|set|add) that)\b/.test(n);
    const isEdit = /\b(actually|wait|no wait|change it|make it|update it|set it to|change to|move it to|reschedule)\b/.test(n);
    if (isCancel) {
      const resp: ReminderAgentResponse = {
        reply: "Done — I've cancelled that reminder.",
        action: { type: "delete_reminder", targetId: body.lastCreatedId },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", resp.reply);
      return NextResponse.json(resp);
    }
    if (isEdit) {
      const newDueAt = parseDateTimeFromInput(message, timeZone);
      if (newDueAt && isValidFutureIsoDate(newDueAt)) {
        const resp: ReminderAgentResponse = {
          reply: `Updated — rescheduled to ${formatDueInUserZone(newDueAt, timeZone)}.`,
          action: { type: "reschedule_reminder", targetId: body.lastCreatedId, dueAt: newDueAt },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", resp.reply);
        return NextResponse.json(resp);
      }
    }
    // Unrecognised follow-up with lastCreatedId — fall through normally.
  }

  // ── Smart create: bounded / conditional reminders ("remind me daily until my
  //    exam is over", "every morning for the next 10 days") + one-round clarify ──
  //    The LLM deeply interprets the request; if it can't resolve the range it asks
  //    ONE question. Best-effort: if the LLM is unavailable it simply falls through
  //    to the ordinary create flow (zero regression).
  const isClarifyAnswer = !!body.pendingClarify?.originalMessage;
  if (isClarifyAnswer || (looksLikeCreateIntent(message) && RANGE_CUE.test(message))) {
    const original = body.pendingClarify?.originalMessage ?? message;
    const analysis = await analyzeReminderRequest(message, {
      timeZone,
      priorContext: isClarifyAnswer ? original : undefined,
    });

    if (analysis?.kind === "series") {
      const resp = buildSmartCreateResponse(analysis, original);
      if (resp) {
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", resp.reply);
        return NextResponse.json(resp);
      }
    }
    // Ask ONE clarifying question — but only on the first turn (never re-ask).
    if (analysis?.kind === "clarify" && !isClarifyAnswer) {
      const resp = buildSmartCreateResponse(analysis, original)!;
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", resp.reply);
      return NextResponse.json(resp);
    }
    // Answer turn that didn't resolve to a series → make a single reminder using
    // the original's title + the date/time the user just supplied. One round only.
    if (isClarifyAnswer) {
      const title = extractTitleFromCreateInput(original) || DEFAULT_CHAT_REMINDER_TITLE;
      const dueAt =
        parseDateTimeFromInput(message, timeZone) ?? parseDateTimeFromInput(`${original} ${message}`, timeZone);
      if (dueAt && isValidFutureIsoDate(dueAt)) {
        const resp: ReminderAgentResponse = {
          reply: `Reminder "${title}" created for ${formatDueInUserZone(dueAt, timeZone)}.`,
          action: { type: "create_reminder", title, dueAt, recurrence: extractRecurrenceFromInput(`${original} ${message}`) },
        };
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", resp.reply);
        return NextResponse.json(resp);
      }
      // Still unresolved after one round — hand to the ordinary flow on the original.
    }
    // Otherwise fall through to the ordinary create flow below.
  }

  if (looksLikeCreateIntent(message) || looksLikeImplicitCreate(message)) {
    const deterministicTitle = extractTitleFromCreateInput(message);
    const deterministicDueAt = parseDateTimeFromInput(message, timeZone);
    const domain = extractDomainFromInput(message);
    const priority = extractPriorityFromInput(message);

    // ── "every N days / every other day" fast path ─────────────────────────────
    // Deterministic — no LLM needed. Generates 30 occurrences starting from the
    // first future occurrence of the given time (or smart-suggested time).
    const everyInterval = parseEveryInterval(message);
    if (everyInterval) {
      const ivTitle = deterministicTitle || DEFAULT_CHAT_REMINDER_TITLE;
      const { profile: ivProfile, domainHourPatterns: ivHourPat } = await loadProfileForSuggestion(userId);
      const ivSuggested = suggestDomainTime(domain, ivTitle, ivProfile, ivHourPat);
      const ivNow = new Date();
      const ivTodayCal = getCalendarDateInTimeZone(ivNow, timeZone);
      let ivStartIso: string;
      if (deterministicDueAt && hasExplicitTime(message)) {
        const ms = new Date(deterministicDueAt).getTime();
        ivStartIso = ms > ivNow.getTime()
          ? deterministicDueAt
          : new Date(ms + 86_400_000).toISOString();
      } else {
        ivStartIso = calendarDateTimeToIso(ivTodayCal, ivSuggested, timeZone);
        if (new Date(ivStartIso).getTime() <= ivNow.getTime()) {
          ivStartIso = calendarDateTimeToIso(addDaysToCalendarDate(ivTodayCal, 1), ivSuggested, timeZone);
        }
      }
      const { stepDays } = everyInterval;
      const ivDueAts = expandByDays(new Date(ivStartIso).getTime(), stepDays, 30)
        .map((ms) => new Date(ms).toISOString());
      const ivLabel = stepDays === 2 ? "every other day" : `every ${stepDays} days`;
      const ivReply = `Setting up "${ivTitle}" — ${ivDueAts.length} reminders (${ivLabel}, starting ${formatDueInUserZone(ivStartIso, timeZone)}).`;
      const ivResp: ReminderAgentResponse = {
        reply: ivReply,
        action: { type: "create_reminder_series", title: ivTitle, priority, domain, seriesDueAts: ivDueAts },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", ivReply);
      return NextResponse.json(ivResp);
    }

    // ── "twice a day / multiple explicit times" fast path ──────────────────────
    // E.g. "remind me at 8 AM and 8 PM to take medicine" → 2 × 14 = 28 reminders.
    const MULTI_TIME_CUE = /\b(twice\s+a\s+day|two\s+times\s+a\s+day|2\s+times\s+a\s+day|thrice\s+a\s+day|three\s+times\s+a\s+day)\b/i;
    const EXPLICIT_TWO_TIMES = /\b\d{1,2}\s*(?:am|pm)(?:.*?\band\b.*?\b\d{1,2}\s*(?:am|pm))+/i;
    const clockTimes = extractClockTimes(message);
    if (clockTimes.length >= 2 && (MULTI_TIME_CUE.test(message) || EXPLICIT_TWO_TIMES.test(message))) {
      const mtTitle = deterministicTitle || DEFAULT_CHAT_REMINDER_TITLE;
      const mtNow = new Date();
      const mtTodayCal = getCalendarDateInTimeZone(mtNow, timeZone);
      const DAYS = 14;
      const mtDueAts: string[] = [];
      for (let d = 0; d < DAYS; d++) {
        const day = addDaysToCalendarDate(mtTodayCal, d);
        for (const t of clockTimes) {
          const iso = calendarDateTimeToIso(day, { hour: t.hour, minute: t.minute }, timeZone);
          if (new Date(iso).getTime() > mtNow.getTime() - 60_000) mtDueAts.push(iso);
        }
      }
      if (mtDueAts.length > 0) {
        const timeLabels = clockTimes
          .map((t) => {
            const h12 = t.hour % 12 || 12;
            const m = t.minute ? `:${String(t.minute).padStart(2, "0")}` : "";
            return `${h12}${m} ${t.hour >= 12 ? "PM" : "AM"}`;
          })
          .join(" & ");
        const mtReply = `Setting up "${mtTitle}" at ${timeLabels} daily — ${mtDueAts.length} reminders over ${DAYS} days.`;
        const mtResp: ReminderAgentResponse = {
          reply: mtReply,
          action: { type: "create_reminder_series", title: mtTitle, priority, domain, seriesDueAts: mtDueAts },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", mtReply);
        return NextResponse.json(mtResp);
      }
    }

    let title = deterministicTitle || DEFAULT_CHAT_REMINDER_TITLE;
    let recurrence = extractRecurrenceFromInput(message);
    let explicitDate = parseCalendarDateFromInput(message, timeZone);

    // ── Date resolution: "LLM interprets, deterministic validates" ─────────────
    // 1. An explicit clock time the deterministic parser locked in always wins —
    //    it's instant and timezone-correct.
    // 2. Otherwise, when the deterministic parsers found NO date signal at all, we
    //    let the LLM interpret ANY phrasing ("the day before my trip", "by the
    //    20th", "end of next week") and then VALIDATE its date before trusting it.
    //    The LLM is best-effort: on any failure (no key / timeout / invalid date)
    //    we fall straight back to deterministic behaviour — zero regression.
    let createDueAt: string | null =
      deterministicDueAt && hasExplicitTime(message) && isValidFutureIsoDate(deterministicDueAt)
        ? deterministicDueAt
        : null;

    const haveDeterministicDate =
      !!explicitDate || hasTodayHint(message) || hasTomorrowHint(message) || hasDayAfterTomorrowHint(message);

    if (!createDueAt && !haveDeterministicDate) {
      const llm = await resolveCreateWithLLM(message, { timeZone });
      if (llm) {
        if (!deterministicTitle && llm.title) title = llm.title;
        if (!recurrence && llm.recurrence && llm.recurrence !== "none") recurrence = llm.recurrence;
        if (llm.dueAt && isValidFutureIsoDate(llm.dueAt)) {
          if (llm.hasExplicitTime) {
            createDueAt = llm.dueAt; // validated LLM time → create directly
          } else {
            // LLM resolved a DATE but no clock time → seed the time suggestion with it.
            try {
              explicitDate = getCalendarDateInTimeZone(new Date(llm.dueAt), timeZone);
            } catch {
              /* keep deterministic explicitDate */
            }
          }
        }
      }
    }

    // ── Past-date warning: user asked for "yesterday" or a past time ───────────
    // When the message explicitly mentions "yesterday" or "last [day]" and we
    // have no valid future date, detect it and bump to tomorrow + tell the user.
    if (!createDueAt && /\b(yesterday|last night)\b/i.test(message) && deterministicDueAt) {
      const pastMs = new Date(deterministicDueAt).getTime();
      if (Number.isFinite(pastMs)) {
        const bumpedMs = pastMs + 86_400_000;
        const bumpedIso = new Date(bumpedMs).toISOString();
        if (isValidFutureIsoDate(bumpedIso)) {
          createDueAt = bumpedIso;
        }
      }
    }

    // ── Confident date + time → create immediately ─────────────────────────────
    if (createDueAt && isValidFutureIsoDate(createDueAt)) {
      // Conflict detection: warn if an existing reminder is within ±5 minutes.
      const CONFLICT_WINDOW_MS = 5 * 60 * 1000;
      const createMs = new Date(createDueAt).getTime();
      const conflicting = reminders.find(
        (r) => r.dueAt && Math.abs(new Date(r.dueAt).getTime() - createMs) <= CONFLICT_WINDOW_MS,
      );
      if (conflicting) {
        const conflictResp: ReminderAgentResponse = {
          reply: `You already have **"${conflicting.title}"** scheduled around that time (${formatDueInUserZone(conflicting.dueAt!, timeZone)}). Want me to create this anyway, or pick a different time?`,
          action: {
            type: "clarify",
            title,
            suggestedDueAt: createDueAt,
            priority,
            domain,
            recurrence,
          },
        };
        void saveMessageServerSide(userId, "user", message);
        void saveMessageServerSide(userId, "assistant", conflictResp.reply);
        return NextResponse.json(conflictResp);
      }

      const wasPastDate = /\b(yesterday|last night)\b/i.test(message);
      const createReply = wasPastDate
        ? `That time has already passed — I've set **"${title}"** for ${formatDueInUserZone(createDueAt, timeZone)} instead.`
        : `Reminder "${title}" created for ${formatDueInUserZone(createDueAt, timeZone)}.`;
      const response: ReminderAgentResponse = {
        reply: createReply,
        action: { type: "create_reminder", title, dueAt: createDueAt, priority, domain, recurrence },
      };
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", response.reply);
      return NextResponse.json(response);
    }

    // ── No explicit time → suggest a time + show the Yes button ─────────────────
    // Seeded with the best date we have: LLM-resolved date > deterministic date >
    // today/day-after hint > tomorrow. We only ever suggest the TIME, never
    // override a date the user actually gave.
    const { profile, domainHourPatterns } = await loadProfileForSuggestion(userId);
    const suggested = suggestDomainTime(domain, title, profile, domainHourPatterns);
    const now = new Date();
    const todayCal = getCalendarDateInTimeZone(now, timeZone);
    let suggestDay = explicitDate ?? addDaysToCalendarDate(todayCal, 1); // default: tomorrow
    if (!explicitDate) {
      if (hasDayAfterTomorrowHint(message)) {
        suggestDay = addDaysToCalendarDate(todayCal, 2);
      } else if (hasTodayHint(message)) {
        suggestDay = todayCal;
      }
    }
    const rawSuggestedDueAt = calendarDateTimeToIso(suggestDay, suggested, timeZone);

    // Safety: if the suggestion is still in the past, nudge to 1 h from now rounded
    // up to the nearest 15-minute mark so the reminder is always in the future.
    const suggestedDueAt = new Date(rawSuggestedDueAt).getTime() > now.getTime()
      ? rawSuggestedDueAt
      : (() => {
          const bumped = new Date(now.getTime() + 60 * 60 * 1000);
          bumped.setMinutes(Math.ceil(bumped.getMinutes() / 15) * 15, 0, 0);
          bumped.setSeconds(0, 0);
          return bumped.toISOString();
        })();
    const timeLabel = formatDueInUserZone(suggestedDueAt, timeZone);

    const response: ReminderAgentResponse = {
      reply: `I can create "${title}". Based on ${suggested.basis}, I suggest **${timeLabel}**. Tap **Yes** to confirm, or tell me a different time.`,
      action: {
        type: "clarify",
        title,
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

  // ─── Single intent classification (card vs answer) ─────────────────────────
  // One reliable decision instead of a dozen overlapping regex checks. With the
  // LLM flag off (default) this equals the deterministic intent (same predicates
  // the handlers use) → zero behaviour change. With CLASSIFY_WITH_LLM on, the LLM
  // disambiguates, and an "info" question can never trip a mutation card.
  const promptCategory = await classifyPrompt(message);

  // ─── Reminder mutation handlers → micro-front-end card (only when "mutate") ──
  if (promptCategory === "mutate") {
    const ctx: ChatContext = { userId, message, effectiveMessage, reminders, tasks, timeZone, history, body };
    for (const handler of [tryBulk, tryMarkDone, tryDelete, tryReschedule, tryEdit, trySnoozeRecovery, trySnooze]) {
      const r = await handler(ctx);
      if (r) return NextResponse.json(r);
    }
  }

  // ─── Fast path: reminders linked to a specific task ─────────────────────────
  // Triggers on "linked to X", "link to X", "for task X" — these are
  // task-scoped list queries; the generic listScopeFromMessage path would
  // otherwise return "all_pending" and lose the task filter entirely.
  if (
    /\b(link(ed)?\s+to|for\s+(?:the\s+)?task|in\s+(?:the\s+)?task)\b/i.test(message) &&
    tasks.length > 0
  ) {
    const msgL = message.toLowerCase();
    const scored = tasks
      .map((t) => {
        // Score by how many 4+ char words from the task title appear in the message
        const words = t.title.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
        const hits = words.filter((w) => msgL.includes(w)).length;
        return { task: t, hits };
      })
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits);
    const matchedTask = scored[0]?.task;
    if (matchedTask) {
      const linked = reminders.filter((r) => r.linkedTaskId === matchedTask.id);
      const listedIds = linked.map((r) => r.id);
      let reply: string;
      if (linked.length === 0) {
        reply = `No reminders are linked to "${matchedTask.title}" yet. Link one by saying "create a reminder for task ${matchedTask.title}".`;
      } else {
        const lines = linked.map((r, i) => `${i + 1}. ${describeReminderForChat(r, new Date(), displayOptions)}`);
        reply = `**Reminders linked to "${matchedTask.title}" (${linked.length}):**\n${lines.join("\n")}`;
      }
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({ reply, action: { type: "list_reminders", listedIds } } satisfies ReminderAgentResponse);
    }
  }

  // ── Context-aware follow-up (no swipe required) ─────────────────────────────
  // A pronoun-style detail question — "what's the date/time of this reminder?",
  // "when is it?", "tell me about that one" — refers to the reminder discussed in
  // the PREVIOUS turn. Resolve it from recent chat history (reusing the same
  // resolver the operation flow uses) so the user never has to swipe-to-reply,
  // and answer about THAT reminder (incl. overdue) instead of a generic list.
  // Runs before list-scope so it isn't swallowed by the "future" catch-all.
  if (
    !isCompoundReminderQuestion(message) &&
    /\b(this|that|it|its)\b/i.test(message) &&
    /\b(date|time|when|due|detail|details|info|about|status)\b/i.test(message)
  ) {
    const ctxTarget = resolveTargetFromHistory(
      history,
      reminders.filter((r) => r.status === "pending"),
    );
    if (ctxTarget) {
      const reply = describeReminderForChat(ctxTarget, new Date(), displayOptions);
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json(
        { reply, action: { type: "list_reminders", listedIds: [ctxTarget.id] } } satisfies ReminderAgentResponse,
      );
    }
  }

  // ── Count query → precise deterministic count (incl. overdue) ───────────────
  // "how many reminders do i have", "reminder count" — answer with a number rather
  // than bouncing to the LLM. Runs before the list path so it isn't turned into a list.
  if (/\b(how many|number of|count of|count)\b/i.test(message) && /\breminders?\b/i.test(message)) {
    const pending = reminders.filter((r) => r.status !== "done");
    const overdue = pending.filter((r) => new Date(r.dueAt).getTime() < Date.now()).length;
    const reply = pending.length === 0
      ? "You have no pending reminders."
      : `You have ${pending.length} pending reminder${pending.length !== 1 ? "s" : ""}${overdue ? `, ${overdue} of them overdue` : ""}.`;
    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", reply);
    return NextResponse.json(
      { reply, action: { type: "list_reminders", listedIds: pending.slice(0, 5).map((r) => r.id) } } satisfies ReminderAgentResponse,
    );
  }

  // ── Specific-reminder query (must beat the generic list path) ───────────────
  // "give me my CLI reminders" names a specific reminder. Answer about it — across
  // ALL statuses (it may be overdue or done) — BEFORE inferListScopeFromMessage,
  // which would otherwise classify it as a "future" list and wrongly report
  // "nothing scheduled ahead". Skipped for explicit scope/topic list requests.
  if (!isCompoundReminderQuestion(message)) {
    const namedAnswer = answerNamedReminderQuery(message, reminders, new Date(), displayOptions);
    if (namedAnswer) {
      const listedIds = findRemindersByName(message, reminders).slice(0, 5).map((r) => r.id);
      void saveMessageServerSide(userId, "user", effectiveMessage);
      void saveMessageServerSide(userId, "assistant", namedAnswer);
      return NextResponse.json(
        { reply: namedAnswer, action: { type: "list_reminders", listedIds } } satisfies ReminderAgentResponse,
      );
    }
  }

  // Precedence guard (#2): the broad list-scope path only runs for reminder-related
  // prompts (classifier said create/mutate/info), never for "other" general chat —
  // so a catch-all scope can't hijack a message that belongs to the LLM.
  const listScopeFromMessage = promptCategory !== "other" ? inferListScopeFromMessage(message) : null;
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
  // Precedence guard (#2): skipped for "other" general chat so the greedy fuzzy
  // matcher can't answer about the wrong reminder (e.g. parroting a previously
  // listed item when the user is just chatting) — those go to the LLM instead.
  if (!isCompoundReminderQuestion(message) && promptCategory !== "other") {
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

  // ─── Keyword search: "related to X" / "about X" fast path ───────────────────
  // findReminderByFuzzyMatch requires 2+ matching tokens which is too strict for
  // short queries like "related to car". This path runs BEFORE the LLM specifically
  // to prevent LLM chat-history confusion (e.g. previous shivshakti listing causes
  // LLM to answer "shivshakti" when user asks about "car").
  // Only triggers when the user explicitly uses a "related to / about" phrasing.
  if (/\brelated\s+to\b/i.test(message) && !isCompoundReminderQuestion(message)) {
    const kwExtract = message.match(/\brelated\s+to\s+(.+?)(?:\?|$)/i)?.[1]?.trim();
    if (kwExtract && kwExtract.length >= 2) {
      // Use the shared word-boundary matcher so "car" matches the word "car" and
      // never "care"/"scarce" (the old `.includes()` produced those false hits).
      // Searches titles + notes across pending reminders (incl. overdue).
      {
        const matched = findRemindersByName(kwExtract, reminders).slice(0, 5);
        const listedIds = matched.map((r) => r.id);
        const reply = matched.length === 0
          ? `No reminders found related to "${kwExtract}".`
          : `Here are the reminders related to "${kwExtract}":\n${matched.map((r, i) => `${i + 1}. ${describeReminderForChat(r, new Date(), displayOptions)}`).join("\n")}`;
        void saveMessageServerSide(userId, "user", effectiveMessage);
        void saveMessageServerSide(userId, "assistant", reply);
        return NextResponse.json({
          reply,
          action: matched.length > 0
            ? { type: "list_reminders", listedIds }
            : { type: "unknown" },
        } satisfies ReminderAgentResponse);
      }
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

    // Intent-based context selection — prevents context-window bloat and hallucination in
    // long sessions.  The wiki and the machine-readable JSON are each expensive in tokens;
    // only include them when the current message actually benefits from them.
    //
    // Wiki (~9 pages × 1 000 tokens) is behavioural knowledge — only useful for insight /
    // planning queries.  CRUD and list queries already have everything they need from the
    // live digest.
    //
    // JSON (3 000–5 000 tokens) duplicates the digest but adds raw Convex IDs.  It is only
    // needed when the LLM must output a precise entity-ID in its action payload (i.e. when
    // the intent is update_reminder and the fast path fell through to the LLM).  For all
    // other intents the digest is authoritative and the JSON adds no value.
    const needsWiki =
      intent === "decision_query" || intent === "planning_query" || intent === "ambiguous";
    const needsJson = intent === "update_reminder";

    // Only fetch wiki from Convex when we actually need it — avoids the I/O cost for CRUD calls.
    const wikiCtx = needsWiki ? await loadUserWiki(userId) : null;

    // BUG-1 / MISSING-1 fix: inject recent conversation history (already loaded above)
    const recentHistory = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_HISTORY_TURNS);

    // Build the user turn content — wiki comes first (rich synthesised knowledge),
    // then the live digest (current reminders),
    // then the machine-readable JSON for precise CRUD actions (only when needed).
    // NOTE: Always use `message` (the raw user text) here — never effectiveMessage which
    // contains a [The user is replying to...] wrapper that causes the LLM to echo it back.
    // Reply context is provided as a clean bracketed note instead.
    const replyContextNote = replyContext?.content?.trim()
      ? `\n\n[Reply context: responding to — "${replyContext.content.trim().slice(0, 200)}"]`
      : "";
    // Prepend a hard-coded temporal anchor so the LLM knows the exact local date/time
    // BEFORE it reads the user message. This prevents it from anchoring on training-data
    // timestamps or drifting into UTC.
    const nowForAnchor = new Date();
    const dateAnchor = nowForAnchor.toLocaleString("en-US", {
      timeZone: timeZone ?? "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    const anchorLine = `[Current date/time: ${dateAnchor}${timeZone ? ` (${timeZone})` : ""}]\n\n`;

    // ── New-user onboarding scaffold ────────────────────────────────────────────
    // When needsWiki is true but the wiki is empty (first session, no history yet),
    // inject a short scaffold so the LLM doesn't hallucinate a persona or give a
    // confusing "I don't see any patterns" reply to a first-time user.
    const newUserScaffold =
      needsWiki && (wikiCtx === "" || wikiCtx === null)
        ? "\n\n[USER KNOWLEDGE WIKI: This is a new user with no prior history. Suggest creating a first reminder if the conversation is open-ended.]"
        : "";

    // ── Token budget guard ──────────────────────────────────────────────────────
    // Estimate tokens as chars ÷ 4.  Drop lower-priority sections progressively if
    // the assembled context exceeds the soft cap (200 k chars ≈ 50 k tokens).
    // This prevents silent context overflow on large accounts and ensures the LLM
    // always has room to produce a full response.
    const TOKEN_CHAR_BUDGET = 200_000; // ~50 k tokens, well inside 128 k model limit

    const jsonSection = needsJson
      ? `\n\n--- LIFE OS JSON (machine-readable IDs) ---\n${JSON.stringify({ reminders: llmReminders, tasks })}`
      : "";

    const wikiSection = needsWiki && wikiCtx ? `\n\n${wikiCtx}` : newUserScaffold;

    const digestSection = `\n\n--- LIFE OS DIGEST (authoritative) ---\n${digest}`;

    let contextParts =
      anchorLine + message + replyContextNote + wikiSection + digestSection + jsonSection;

    // Drop JSON first if over budget
    if (contextParts.length > TOKEN_CHAR_BUDGET) {
      contextParts = anchorLine + message + replyContextNote + wikiSection + digestSection;
    }
    // Drop wiki next if still over budget
    if (contextParts.length > TOKEN_CHAR_BUDGET) {
      contextParts = anchorLine + message + replyContextNote + digestSection;
    }

    // ── Intent-based max_tokens ─────────────────────────────────────────────────
    // Planning and decision queries need more room to enumerate items, explain
    // patterns, and provide actionable breakdowns.  Everything else stays at 900.
    const maxTokens =
      intent === "planning_query" || intent === "decision_query" ? 1200 : 900;

    const nimMessages = [
      { role: "system" as const, content: systemPrompt },
      ...recentHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: contextParts },
    ];

    // ── AbortController with 12-second timeout ──────────────────────────────────
    // Prevents hung requests from leaving the user waiting indefinitely.
    // On timeout the catch block returns a deterministic fallback reply.
    const nimAbortController = new AbortController();
    const nimTimeoutId = setTimeout(() => nimAbortController.abort(), 12_000);

    const nimResponse = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nimApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: nimMessages, temperature: 0.2, max_tokens: maxTokens }),
      signal: nimAbortController.signal,
    });

    clearTimeout(nimTimeoutId);

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

    // Override LLM-generated dueAt for reschedule with the same deterministic parser used for
    // create_reminder. Without this, the LLM's potentially UTC-anchored timestamp is used as-is.
    if (parsed.action.type === "reschedule_reminder") {
      const deterministicDueAt = parseDateTimeFromInput(message, timeZone);
      if (deterministicDueAt) parsed.action.dueAt = deterministicDueAt;
    }

    // The system never commits a reschedule. Resolve the target so the client
    // opens the correct card, then mark it a PREVIEW — the user taps Save to commit.
    if (parsed.action.type === "reschedule_reminder" && parsed.action.dueAt) {
      const rsTarget = findTargetReminder(reminders, parsed.action.targetId, parsed.action.targetTitle);
      if (rsTarget && isValidFutureIsoDate(parsed.action.dueAt)) {
        parsed.action.targetId = rsTarget.id;
      }
    }

    // ── Human-in-the-loop guard for ALL LLM-emitted mutations ──────────────────
    // The system must never auto-commit a CRUD change. Any mutation action the
    // LLM produces is downgraded to a PREVIEW: the client renders a prefilled card
    // and the user commits via Save. (create is handled separately, see below.)
    if (
      parsed.action.targetId &&
      (parsed.action.type === "reschedule_reminder" ||
        parsed.action.type === "edit_reminder" ||
        parsed.action.type === "delete_reminder" ||
        parsed.action.type === "mark_done" ||
        parsed.action.type === "snooze_reminder")
    ) {
      parsed.action.preview = true;
    }

    if (parsed.action.type === "create_reminder") {
      const deterministicDueAt = parseDateTimeFromInput(message, timeZone);
      if (deterministicDueAt) parsed.action.dueAt = deterministicDueAt;

      // Always prefer the deterministic title extractor over the LLM title.
      // The LLM frequently returns "for update meeting" instead of "update meeting"
      // when the user says "create reminder for update meeting at 4pm".
      const deterministicTitle = extractTitleFromCreateInput(message);
      if (deterministicTitle) parsed.action.title = deterministicTitle;

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

    // Phase 1A — server-side execution for edit_reminder.
    // edit_reminder from the LLM path bypasses the fast-path pending_confirm flow,
    // so we execute it here to guarantee persistence.
    {
      const a = parsed.action;
      const hasEditPayload =
        a.type === "edit_reminder" &&
        (a.newTitle || a.newNotes !== undefined ||
         a.newPriority !== undefined || a.newDomain !== undefined ||
         a.newRecurrence !== undefined || a.newLinkedTaskId !== undefined);
      if (hasEditPayload) {
        const editTarget = findTargetReminder(reminders, a.targetId, a.targetTitle);
        if (editTarget) {
          try {
            const convex = await getAuthedConvexClient();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const patch: Record<string, any> = {};
            if (a.newTitle) patch.title = a.newTitle;
            if (a.newNotes !== undefined) patch.notes = a.newNotes;
            if (a.newPriority !== undefined) patch.priority = a.newPriority;
            if (a.newDomain !== undefined) patch.domain = a.newDomain; // null = clear
            if (a.newRecurrence !== undefined) patch.recurrence = a.newRecurrence;
            if (a.newLinkedTaskId !== undefined) patch.linkedTaskId = a.newLinkedTaskId; // null = delink
            await convex.mutation(api.reminders.update, {
              userId,
              reminderId: editTarget.id as any,
              ...patch,
            });
            a.targetId = editTarget.id;
          } catch {
            // Non-fatal
          }
        }
      }
    }

    void saveMessageServerSide(userId, "user", effectiveMessage);
    void saveMessageServerSide(userId, "assistant", parsed.reply);
    return NextResponse.json(parsed);

  } catch (err: unknown) {
    // AbortController timeout fires — the NIM call took > 12 s.
    // Return a deterministic fallback so the user still gets a useful response.
    if (err instanceof Error && err.name === "AbortError") {
      const reply = fallbackDeterministicReply(message, reminders, timeZone);
      void saveMessageServerSide(userId, "user", message);
      void saveMessageServerSide(userId, "assistant", reply);
      return NextResponse.json({ reply, action: { type: "unknown" } });
    }
    const reply = fallbackDeterministicReply(message, reminders, timeZone);
    void saveMessageServerSide(userId, "user", message);
    void saveMessageServerSide(userId, "assistant", reply);
    return NextResponse.json({ reply, action: { type: "unknown" } });
  }
}
