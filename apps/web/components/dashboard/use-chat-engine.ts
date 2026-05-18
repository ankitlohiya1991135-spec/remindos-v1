"use client";

/**
 * useChatEngine
 *
 * Custom hook encapsulating applyAction + handleChatSubmit logic.
 * Extracted from dashboard-workspace.tsx to reduce file size.
 */

import { type FormEvent, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import {
  tryGroundedReminderAnswer,
  looksLikeMarkDoneIntent,
  looksLikeDeleteIntent,
  type ReminderItem,
} from "@repo/reminder";
import type { TaskRow } from "./task-panels";
import type {
  ChatMessage,
  AgentAction,
  AgentResponse,
  PendingCreateDraft,
  PendingConfirmAction,
  PendingDisambig,
  PendingTimeSuggestion,
} from "./dashboard-types";
import {
  extractInviteToken,
  DEFAULT_CHAT_REMINDER_TITLE,
  clientTimeZonePayload,
  toReplyContextPayload,
  extractCreateTitle,
  hasInlineCreateDetails,
  parseDateInput,
  parseTimeInput,
  matchesReminder,
} from "./dashboard-utils";
import type { ReplyContextPayload } from "../../lib/chat-reply-context";

export interface UseChatEngineParams {
  quickSubmitTextRef: MutableRefObject<string | null>;
  input: string;
  isLoading: boolean;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setLoadingTextIndex: Dispatch<SetStateAction<number>>;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  replyTarget: ChatMessage | null;
  setReplyTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  editingMessageId: string | null;
  setEditingMessageId: Dispatch<SetStateAction<string | null>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  chatPinnedToBottomRef: MutableRefObject<boolean>;
  briefingStreaming: boolean;
  reminders: ReminderItem[];
  tasks: TaskRow[];
  pendingDisambig: PendingDisambig | null;
  setPendingDisambig: Dispatch<SetStateAction<PendingDisambig | null>>;
  pendingCreateDraft: PendingCreateDraft | null;
  setPendingCreateDraft: Dispatch<SetStateAction<PendingCreateDraft | null>>;
  pendingConfirmAction: PendingConfirmAction | null;
  setPendingConfirmAction: Dispatch<SetStateAction<PendingConfirmAction | null>>;
  pendingTimeSuggestion: PendingTimeSuggestion | null;
  setPendingTimeSuggestion: Dispatch<SetStateAction<PendingTimeSuggestion | null>>;
  recentListedIds: string[];
  setRecentListedIds: Dispatch<SetStateAction<string[]>>;
  refreshReminders: () => Promise<void>;
  /** Immediately update local reminder state for optimistic UI — before the API call resolves.
   *  On API failure the caller should invoke refreshReminders() to re-sync from the server. */
  optimisticUpdateReminder: (updater: (prev: ReminderItem[]) => ReminderItem[]) => void;
  playReminderSuccessAnimation: (info?: { title: string; time: string }) => void;
  refreshAfterReminderMutation: (promise: Promise<Response>) => Promise<void>;
  showShareToast: (msg: string) => void;
}

export function useChatEngine(params: UseChatEngineParams) {
  const {
    quickSubmitTextRef,
    input,
    isLoading,
    setIsLoading,
    setLoadingTextIndex,
    messages,
    setMessages,
    setInput,
    replyTarget,
    setReplyTarget,
    editingMessageId,
    setEditingMessageId,
    messagesRef,
    chatPinnedToBottomRef,
    briefingStreaming,
    reminders,
    tasks,
    pendingDisambig,
    setPendingDisambig,
    pendingCreateDraft,
    setPendingCreateDraft,
    pendingConfirmAction,
    setPendingConfirmAction,
    pendingTimeSuggestion,
    setPendingTimeSuggestion,
    recentListedIds,
    setRecentListedIds,
    refreshReminders,
    optimisticUpdateReminder,
    playReminderSuccessAnimation,
    refreshAfterReminderMutation,
    showShareToast,
  } = params;

  // Suppress unused variable warning for messages (used via messagesRef)
  void messages;

  function pendingTaskChoices() {
    return tasks.filter((t) => t.status === "pending").slice(0, 8);
  }

  function taskChoicePrompt(choices: TaskRow[]) {
    if (choices.length === 0) {
      return "Step 3/4: Should this reminder be linked to a task? Reply " +
        '"no" for standalone.';
    }
    return [
      "Step 3/4: Which task is this reminder related to?",
      ...choices.map((t, idx) => `${idx + 1}. ${t.title}`),
      'Reply with number/name, or "no" for standalone.',
    ].join("\n");
  }

  function applyAction(action: AgentAction) {
    // Clear stale pending state for every action type except pending_confirm (which sets it)
    // This prevents a stale "yes" from firing a previously abandoned confirmation.
    if (action.type !== "pending_confirm") {
      setPendingConfirmAction(null);
    }
    // Clear stale listed IDs for every non-list action — prevents ordinal resolution
    // from targeting a reminder list from many turns ago.
    if (action.type !== "list_reminders") {
      setRecentListedIds([]);
    }

    if (action.type === "create_reminder" && action.title && action.dueAt) {
      setPendingCreateDraft(null);
      setPendingDisambig(null);
      const title = action.title;
      const dueAt = action.dueAt;
      const isDuplicate = reminders.some(
        (item) =>
          item.status === "pending" &&
          item.title.trim().toLowerCase() === title.trim().toLowerCase() &&
          new Date(item.dueAt).getTime() === new Date(dueAt).getTime(),
      );
      if (isDuplicate) return;

      void (async () => {
        const validRecurrences = ["none", "daily", "weekly", "monthly"] as const;
        const validDomains = ["health", "finance", "career", "hobby", "fun"] as const;
        try {
          const res = await fetch("/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              dueAt: new Date(dueAt).getTime(),
              notes: action.notes?.trim() ? action.notes : undefined,
              recurrence: validRecurrences.includes(action.recurrence as typeof validRecurrences[number])
                ? action.recurrence
                : "none",
              priority:
                typeof action.priority === "number" && action.priority >= 1 && action.priority <= 5
                  ? action.priority
                  : 3,
              domain: validDomains.includes(action.domain as typeof validDomains[number])
                ? action.domain
                : undefined,
              linkedTaskId: action.linkedTaskId?.trim() ? action.linkedTaskId : undefined,
            }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            created?: boolean;
            error?: string;
          };
          if (!res.ok) {
            showShareToast(data.error ?? "Could not save the reminder. Please try again.");
            return;
          }
          await refreshReminders();
          playReminderSuccessAnimation();
        } catch {
          showShareToast("Could not save the reminder. Please try again.");
        }
      })();
      return;
    }

    if (action.type === "mark_done") {
      setPendingConfirmAction(null);
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) {
        // Could not find the reminder locally — it may already be done or the server handled it
        showShareToast("Couldn't find that reminder. It may already be completed.");
        void refreshReminders();
        return;
      }
      // Optimistic: mark done instantly so the UI doesn't wait for the API
      optimisticUpdateReminder((prev) =>
        prev.map((r) => r.id === target.id ? { ...r, status: "done" as const } : r),
      );
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        }),
      ).catch(() => {
        showShareToast("Could not update reminder. Try again.");
        void refreshReminders(); // rollback to server state
      });
      return;
    }

    if (action.type === "delete_reminder") {
      setPendingConfirmAction(null);
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) {
        showShareToast("Couldn't find that reminder. It may have already been deleted.");
        void refreshReminders();
        return;
      }
      // Optimistic: remove immediately so the list updates before API returns
      optimisticUpdateReminder((prev) => prev.filter((r) => r.id !== target.id));
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, { method: "DELETE" }),
      ).catch(() => {
        showShareToast("Could not delete reminder. Try again.");
        void refreshReminders(); // rollback to server state
      });
      return;
    }

    if (action.type === "snooze_reminder" && typeof action.delayMinutes === "number" && action.delayMinutes > 0) {
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) {
        showShareToast("Couldn't find that reminder to snooze.");
        void refreshReminders();
        return;
      }
      const newDueAt = Date.now() + action.delayMinutes * 60_000;
      // Optimistic: update due time immediately
      optimisticUpdateReminder((prev) =>
        prev.map((r) =>
          r.id === target.id ? { ...r, dueAt: new Date(newDueAt).toISOString() } : r,
        ),
      );
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueAt: newDueAt }),
        }),
      ).catch(() => {
        showShareToast("Could not snooze reminder. Try again.");
        void refreshReminders(); // rollback
      });
      return;
    }

    if (action.type === "edit_reminder" && (action.newTitle || action.newNotes !== undefined)) {
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) {
        // Server (Phase 1A) may have already applied the edit; refresh to show updated state
        void refreshReminders();
        return;
      }
      const patch: Record<string, unknown> = {
        priority: typeof target.priority === "number" ? target.priority : 3,
      };
      if (action.newTitle) patch.title = action.newTitle;
      if (typeof action.newNotes === "string") patch.notes = action.newNotes;
      // Optimistic: apply the edit locally before the server confirms
      optimisticUpdateReminder((prev) =>
        prev.map((r) =>
          r.id === target.id
            ? {
                ...r,
                ...(action.newTitle ? { title: action.newTitle } : {}),
                ...(typeof action.newNotes === "string" ? { notes: action.newNotes } : {}),
              }
            : r,
        ),
      );
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ).catch(() => {
        showShareToast("Could not edit reminder. Try again.");
        void refreshReminders(); // rollback
      });
      return;
    }

    if (action.type === "bulk_action" && action.bulkOperation && action.bulkTargetIds?.length) {
      const ids = action.bulkTargetIds;
      const op = action.bulkOperation;
      void (async () => {
        const results = await Promise.allSettled(
          ids.map((id) =>
            op === "delete"
              ? fetch(`/api/reminders/${id}`, { method: "DELETE" })
              : fetch(`/api/reminders/${id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: "done" }),
                }),
          ),
        );
        const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
        if (failed > 0) {
          showShareToast(`${failed} of ${ids.length} reminders could not be ${op === "delete" ? "deleted" : "marked done"}. Try again.`);
        }
        await refreshReminders();
      })();
      return;
    }

    if (action.type === "reschedule_reminder" && action.dueAt) {
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) {
        // Server (Phase 1A) may have already rescheduled; refresh to reflect new date
        void refreshReminders();
        return;
      }
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueAt: new Date(action.dueAt).getTime() }),
        }),
      ).catch(() => showShareToast("Could not reschedule reminder. Try again."));
    }

    if (action.type === "pending_confirm" && action.pendingType) {
      setPendingConfirmAction({
        type: action.pendingType,
        targetId: action.targetId,
        targetTitle: action.targetTitle,
        targetIds: action.bulkTargetIds,
        // edit_reminder confirmation carries the new value
        newTitle: action.newTitle,
        newNotes: action.newNotes,
      });
      return;
    }

    // Gap 7: store listed IDs so the next turn can use ordinal references
    // (cleared at the top of applyAction for every non-list action)
    if (action.type === "list_reminders" && action.listedIds?.length) {
      setRecentListedIds(action.listedIds);
    }

    if (action.type === "clarify") {
      // Disambiguation clarify: user was asked "which one?" for any CRUD op.
      // Store full context so the next reply resolves the correct reminder
      // instead of accidentally starting the create-reminder wizard.
      if (action.pendingOp && action.candidateIds?.length) {
        if (action.pendingOp === "reschedule" && action.pendingDueAt) {
          setPendingDisambig({ op: "reschedule", candidateIds: action.candidateIds, pendingDueAt: action.pendingDueAt });
        } else if (action.pendingOp === "edit" && action.pendingField && action.pendingValue != null) {
          setPendingDisambig({ op: "edit", candidateIds: action.candidateIds, pendingField: action.pendingField, pendingValue: action.pendingValue });
        } else if (action.pendingOp === "snooze" && action.pendingDelayMinutes) {
          setPendingDisambig({ op: "snooze", candidateIds: action.candidateIds, pendingDelayMinutes: action.pendingDelayMinutes });
        } else if (action.pendingOp === "mark_done" || action.pendingOp === "delete") {
          setPendingDisambig({ op: action.pendingOp, candidateIds: action.candidateIds });
        }
        setPendingCreateDraft(null);
        return;
      }

      // Gap 8: if the server included a time suggestion, store it for confirmation on next turn.
      // Fix: don't activate BOTH wizard and suggestion simultaneously — pick suggestion path only,
      // skip setPendingCreateDraft so the two flows don't conflict.
      if (action.suggestedDueAt && action.title) {
        // Fix: suggestion path takes over — don't also activate the step-by-step wizard
        // which would leave both pendingTimeSuggestion AND pendingCreateDraft alive,
        // causing a spurious duplicate reminder on wizard completion.
        setPendingTimeSuggestion({
          title: action.title,
          suggestedDueAt: action.suggestedDueAt,
          priority: action.priority,
          domain: typeof action.domain === "string" ? action.domain : undefined,
          recurrence: typeof action.recurrence === "string" ? action.recurrence : undefined,
        });
        // Clear any stale wizard/disambig so it doesn't conflict
        setPendingCreateDraft(null);
        setPendingDisambig(null);
        return;
      }
      setPendingDisambig(null);
      setPendingCreateDraft({
        step: action.title ? "date" : "title",
        title: action.title,
        notes: action.notes,
      });
    }
  }

  async function handleChatSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = (quickSubmitTextRef.current ?? input).trim();
    quickSubmitTextRef.current = null;
    if (!prompt || isLoading) return;

    const dispatchAssistantResponse = async (
      messageText: string,
      responseReplyPayload: ReplyContextPayload | undefined,
      _messagesSnapshot: ChatMessage[],
    ) => {
      try {
        const inviteToken = extractInviteToken(messageText);
        if (inviteToken) {
          const res = await fetch(
            `/api/reminders/share/${encodeURIComponent(inviteToken)}`,
            {
              method: "POST",
            },
          );
          const data = (await res.json()) as { error?: string; title?: string };
          if (!res.ok) {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: data.error ?? "Could not accept that invite.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }
          await refreshReminders();
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: data.title
                ? `You're in on "${data.title}". It is now in your reminder list.`
                : "Invite accepted.",
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }

        // ─── Disambiguation resolution (all CRUD ops) ────────────────────────
        // User was asked "Which one do you mean?" — their reply is a clarifying
        // title. Resolve it here, client-side, without hitting the server so we
        // never accidentally fall into the create-reminder wizard.
        if (pendingDisambig) {
          const text = messageText.trim().toLowerCase();

          // Escape hatch: user explicitly cancels
          if (/^(cancel|nevermind|never mind|stop|abort|no|nope)\b/i.test(messageText.trim())) {
            setPendingDisambig(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Got it — operation cancelled.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          const candidates = reminders.filter((r) =>
            pendingDisambig.candidateIds.includes(r.id),
          );

          // Collapse spaces, hyphens and underscores so "fix up" ≡ "fixup".
          const normalizeForMatch = (s: string) =>
            s.toLowerCase().replace(/[\s\-_]+/g, "");
          const normText = normalizeForMatch(text);

          // Match strategy — require exactly ONE candidate to match to avoid
          // silently picking the wrong reminder when both share keywords.
          // Phase 0: normalised exact match — handles "fix up" vs "fixup" variants
          const normalizedMatches = candidates.filter((r) => {
            const normTitle = normalizeForMatch(r.title);
            return normText.includes(normTitle) || normTitle.includes(normText);
          });
          // Phase 1: raw exact substring (title fully inside text, or text inside title)
          const exactMatches =
            normalizedMatches.length > 0
              ? normalizedMatches
              : candidates.filter((r) => {
                  const title = r.title.toLowerCase();
                  return text.includes(title) || title.includes(text);
                });
          // Phase 2: any meaningful token (≥4 chars) from the title appears in user text
          const tokenMatches =
            exactMatches.length > 0
              ? exactMatches
              : candidates.filter((r) => {
                  const tokens = r.title
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((t) => t.length >= 4);
                  return tokens.some((token) => text.includes(token));
                });

          if (tokenMatches.length > 1) {
            // Still ambiguous — ask again with more detail
            const sample = tokenMatches.slice(0, 3).map((r) => `"${r.title}"`);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `I still can't tell which one. Please give more of the title — ${sample.join(", ")}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
            return; // keep pendingDisambig active
          }

          const match = tokenMatches[0] ?? null;

          if (!match) {
            // No candidate matched — clear context and let user retry from scratch
            setPendingDisambig(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content:
                  "I couldn't match that to any of the reminders I mentioned. Please try again.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          // Unique match found — capture state snapshot BEFORE clearing,
          // then resolve based on op type.
          const disambigSnapshot = pendingDisambig;
          setPendingDisambig(null);
          const { op } = disambigSnapshot;

          if (op === "mark_done" || op === "delete") {
            // Needs "are you sure?" confirmation before executing
            const actionVerb = op === "mark_done" ? "mark as done" : "delete";
            setPendingConfirmAction({
              type: op === "mark_done" ? "mark_done" : "delete_reminder",
              targetId: match.id,
              targetTitle: match.title,
            });
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Are you sure you want to ${actionVerb} "${match.title}"? Reply **yes** to confirm.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else if (op === "reschedule") {
            // Execute directly — reschedule doesn't need a "are you sure?" step
            const newDueAt = disambigSnapshot.pendingDueAt;
            void refreshAfterReminderMutation(
              fetch(`/api/reminders/${match.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dueAt: new Date(newDueAt).getTime() }),
              }),
            ).catch(() => showShareToast("Could not reschedule reminder. Try again."));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Rescheduled "${match.title}" to ${new Date(newDueAt).toLocaleString()}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else if (op === "edit") {
            // Needs confirmation before applying (consistent with normal edit flow)
            const { pendingField, pendingValue } = disambigSnapshot;
            const previewValue = pendingValue.length > 40 ? `${pendingValue.slice(0, 40)}…` : pendingValue;
            setPendingConfirmAction({
              type: "edit_reminder",
              targetId: match.id,
              targetTitle: match.title,
              ...(pendingField === "title" ? { newTitle: pendingValue } : { newNotes: pendingValue }),
            });
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Change the ${pendingField} of "${match.title}" to "${previewValue}"? Reply **yes** to confirm.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else if (op === "snooze") {
            // Execute directly — snooze doesn't need a "are you sure?" step
            const { pendingDelayMinutes } = disambigSnapshot;
            const newDueAt = Date.now() + pendingDelayMinutes * 60_000;
            const label =
              pendingDelayMinutes >= 60
                ? `${Math.round(pendingDelayMinutes / 60)} hour${Math.round(pendingDelayMinutes / 60) !== 1 ? "s" : ""}`
                : `${pendingDelayMinutes} minute${pendingDelayMinutes !== 1 ? "s" : ""}`;
            void refreshAfterReminderMutation(
              fetch(`/api/reminders/${match.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dueAt: newDueAt }),
              }),
            ).catch(() => showShareToast("Could not snooze reminder. Try again."));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Snoozed "${match.title}" — I'll remind you again in ${label}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
          return;
        }

        // ── Create-wizard escape hatch ──────────────────────────────────────────
        // CRUD intent (mark done / delete) while in a structured step means the
        // user wants to do something else. Clear the draft and let the message
        // fall through to normal processing. The title step is exempt because any
        // text is a valid reminder title there.
        const skipWizardForCrud =
          pendingCreateDraft !== null &&
          pendingCreateDraft.step !== "title" &&
          (looksLikeMarkDoneIntent(messageText.trim()) ||
            looksLikeDeleteIntent(messageText.trim()));
        if (skipWizardForCrud) setPendingCreateDraft(null);

        if (pendingCreateDraft && !skipWizardForCrud) {
          const text = messageText.trim();

          // Explicit cancel at any step
          if (/^(cancel|nevermind|never mind|stop|abort|quit)\b/i.test(text)) {
            setPendingCreateDraft(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Got it — reminder creation cancelled.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "title") {
            if (!text) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "What should the reminder title be?",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "date" as const }),
              step: "date",
              title: text,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Step 1/4: What date should I set? (today / tomorrow / YYYY-MM-DD)",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "date") {
            const dateIso = parseDateInput(text, new Date());
            if (!dateIso) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "Please share a valid date: today, tomorrow, or YYYY-MM-DD.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "time" as const }),
              step: "time",
              dateIso,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Step 2/4: What time? (e.g. 8:30 PM or 20:30)",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "time") {
            const time24 = parseTimeInput(text);
            if (!time24 || !pendingCreateDraft.dateIso) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "Please share a valid time, like 8:30 PM or 20:30.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            const dueAt = new Date(`${pendingCreateDraft.dateIso}T${time24}:00`).toISOString();
            if (!Number.isFinite(new Date(dueAt).getTime()) || new Date(dueAt).getTime() <= Date.now()) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "That date/time is in the past. Please send a future time.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            const choices = pendingTaskChoices();
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "task" as const }),
              step: "task",
              dueAt,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: taskChoicePrompt(choices),
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "task") {
            const choices = pendingTaskChoices();
            let linkedTaskId = "";
            if (!/^(no|none|standalone|skip)$/i.test(text)) {
              const byIndex = Number(text);
              if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
                linkedTaskId = choices[byIndex - 1]?.id ?? "";
              } else {
                const byName = choices.find((t) => t.title.toLowerCase().includes(text.toLowerCase()));
                if (!byName) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: taskChoicePrompt(choices),
                      createdAt: new Date().toISOString(),
                    },
                  ]);
                  return;
                }
                linkedTaskId = byName.id;
              }
            }
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "priority" as const }),
              step: "priority",
              linkedTaskId,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Step 4/4: Set priority (1 to 5 stars).",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "priority") {
            const mapWord: Record<string, number> = {
              one: 1,
              two: 2,
              three: 3,
              four: 4,
              five: 5,
            };
            const parsedNum = Number(text);
            const priority = Number.isFinite(parsedNum)
              ? Math.trunc(parsedNum)
              : mapWord[text.toLowerCase()] ?? 0;
            if (priority < 1 || priority > 5) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "Please choose a priority between 1 and 5.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }

            const title = pendingCreateDraft.title?.trim();
            const dueAt = pendingCreateDraft.dueAt;
            if (!title || !dueAt) {
              setPendingCreateDraft(null);
              setPendingDisambig(null);
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "I lost context for this draft. Please say 'create reminder' again.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }

            const res = await fetch("/api/reminders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title,
                dueAt: new Date(dueAt).getTime(),
                recurrence: "none",
                priority,
                linkedTaskId: pendingCreateDraft.linkedTaskId || undefined,
              }),
            });
            if (!res.ok) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "I couldn't create the reminder. Please try once more.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            await refreshReminders();
            playReminderSuccessAnimation();
            setPendingCreateDraft(null);
            setPendingDisambig(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Done — reminder created for ${new Date(dueAt).toLocaleString()}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }
        }

        if (
          /^\s*create(\s+a)?\s+reminder\b/i.test(messageText) &&
          !hasInlineCreateDetails(messageText)
        ) {
          const extractedTitle =
            extractCreateTitle(messageText) || DEFAULT_CHAT_REMINDER_TITLE;
          setPendingCreateDraft({ step: "date", title: extractedTitle });
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "Step 1/4: What date should I set? (today / tomorrow / YYYY-MM-DD)",
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }

        const pendingActionSnapshot = pendingConfirmAction
          ?? (pendingTimeSuggestion
            ? {
                type: "create_reminder" as const,
                title: pendingTimeSuggestion.title,
                // Server reads body.pendingAction.dueAt — map suggestedDueAt → dueAt
                dueAt: pendingTimeSuggestion.suggestedDueAt,
                priority: pendingTimeSuggestion.priority,
                domain: pendingTimeSuggestion.domain,
                recurrence: pendingTimeSuggestion.recurrence,
              }
            : null);
        setPendingConfirmAction(null);
        setPendingTimeSuggestion(null);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: messageText,
            reminders,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              notes: t.notes,
              dueAt: t.dueAt,
              status: t.status,
              priority: t.priority,
              domain: t.domain,
            })),
            ...clientTimeZonePayload(),
            ...(responseReplyPayload ? { replyContext: responseReplyPayload } : {}),
            ...(pendingActionSnapshot ? { pendingAction: pendingActionSnapshot } : {}),
            ...(recentListedIds.length > 0 ? { recentListedIds } : {}),
          }),
        });

        const data = (await response.json()) as AgentResponse;
        applyAction(data.action);

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.reply || "Done.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch {
        const grounded = tryGroundedReminderAnswer(
          messageText,
          reminders,
          new Date(),
          clientTimeZonePayload(),
        );
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              grounded ??
              "I could not reach the assistant. Check your connection and try again.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    };

    if (editingMessageId) {
      const editedAt = new Date().toISOString();
      const editingMessage = messagesRef.current.find(
        (m) => m.id === editingMessageId,
      );
      const replyFromEditedMessage = editingMessage?.meta?.replyTo
        ? {
            id: editingMessage.meta.replyTo.id,
            content: editingMessage.meta.replyTo.content,
            role: editingMessage.meta.replyTo.role,
          }
        : undefined;

      const nextMessages = (() => {
        const index = messagesRef.current.findIndex(
          (m) => m.id === editingMessageId,
        );
        if (index === -1) return messagesRef.current;
        return messagesRef.current.slice(0, index + 1).map((m) =>
          m.id === editingMessageId && m.role === "user"
            ? {
                ...m,
                content: prompt,
                meta: { ...(m.meta ?? {}), editedAt },
              }
            : m,
        );
      })();

      setMessages(nextMessages);
      setInput("");
      setEditingMessageId(null);
      setReplyTarget(null);
      chatPinnedToBottomRef.current = true;
      setIsLoading(true);
      setLoadingTextIndex(0);
      void dispatchAssistantResponse(prompt, replyFromEditedMessage, nextMessages);
      return;
    }

    if (briefingStreaming) return;

    chatPinnedToBottomRef.current = true;

    const replySnapshot = replyTarget;
    const replyPayload = toReplyContextPayload(replySnapshot);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
      ...(replySnapshot
        ? {
            meta: {
              replyTo: {
                id: replySnapshot.id,
                content: replySnapshot.content,
                role: replySnapshot.role,
              },
            },
          }
        : {}),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setReplyTarget(null);
    setIsLoading(true);
    setLoadingTextIndex(0);
    void dispatchAssistantResponse(prompt, replyPayload, messagesRef.current);
  }

  return { handleChatSubmit, applyAction };
}
