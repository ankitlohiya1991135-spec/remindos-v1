"use client";

/**
 * useChatEngine
 *
 * Custom hook encapsulating applyAction + handleChatSubmit logic.
 * Extracted from dashboard-workspace.tsx to reduce file size.
 */

import { useRef, type FormEvent, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import {
  tryGroundedReminderAnswer,
  looksLikeMarkDoneIntent,
  looksLikeDeleteIntent,
  looksLikeRescheduleIntent,
  looksLikeEditIntent,
  type ReminderItem,
} from "@repo/reminder";
import type { TaskRow } from "./task-panels";
import type {
  ChatMessage,
  ChatMessageMeta,
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
  refreshTasks: () => Promise<void>;
  /** Immediately update local reminder state for optimistic UI — before the API call resolves.
   *  On API failure the caller should invoke refreshReminders() to re-sync from the server. */
  optimisticUpdateReminder: (updater: (prev: ReminderItem[]) => ReminderItem[]) => void;
  playReminderSuccessAnimation: (info?: { title: string; time: string }) => void;
  /** Fire a Win Celebration when a reminder is completed from chat / a chat card. */
  onReminderCompleted?: (reminder: ReminderItem) => void;
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
    refreshTasks,
    optimisticUpdateReminder,
    playReminderSuccessAnimation,
    onReminderCompleted,
    refreshAfterReminderMutation,
    showShareToast,
  } = params;

  // Suppress unused variable warning for messages (used via messagesRef)
  void messages;

  // Smart-create one-round clarify: holds the original request while we wait for
  // the user's answer to the single clarifying question. Cleared on next submit.
  const pendingClarifyRef = useRef<{ originalMessage: string } | null>(null);
  // Conversational edit/cancel: the ID of the last created reminder, so the user
  // can say "actually make it 6 PM" or "cancel that" immediately after creation.
  const lastCreatedIdRef = useRef<string | null>(null);

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
    // Operation PREVIEWS are never executed by the system. The client renders a
    // prefilled editable card (micro front-end) and the user commits via Save —
    // keeping every chat mutation human-in-the-loop. The card's Save dispatches a
    // NON-preview action back through applyAction, which then executes normally.
    if (action.preview) return;

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
            reminder?: { _id?: string };
          };
          if (!res.ok) {
            showShareToast(data.error ?? "Could not save the reminder. Please try again.");
            return;
          }
          await refreshReminders();
          playReminderSuccessAnimation();
          // Inject an interactive card for the newly created reminder
          const createdId = String(data.reminder?._id ?? "");
          if (createdId) {
            lastCreatedIdRef.current = createdId;
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant" as const,
                content: "",
                createdAt: new Date().toISOString(),
                meta: { kind: "reminder_card" as const, reminderIds: [createdId], totalListedCount: 1 },
              },
            ]);
          }
        } catch {
          showShareToast("Could not save the reminder. Please try again.");
        }
      })();
      return;
    }

    // ── Smart create: a bounded series ("daily until my exam ends") → create each occurrence ──
    if (action.type === "create_reminder_series" && action.title && action.seriesDueAts?.length) {
      setPendingCreateDraft(null);
      setPendingTimeSuggestion(null);
      const title = action.title;
      const dueAts = action.seriesDueAts;
      const recurrence = (["none", "daily", "weekly", "monthly"] as const).includes(
        action.recurrence as "none" | "daily" | "weekly" | "monthly",
      )
        ? action.recurrence
        : "none";
      void (async () => {
        let ok = 0;
        for (const iso of dueAts) {
          try {
            const res = await fetch("/api/reminders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, dueAt: new Date(iso).getTime(), recurrence, priority: 3 }),
            });
            if (res.ok) ok++;
          } catch {
            /* keep going — partial success is still useful */
          }
        }
        await refreshReminders();
        if (ok > 0) playReminderSuccessAnimation();
        showShareToast(
          ok === dueAts.length
            ? `Added ${ok} reminders for "${title}".`
            : `Added ${ok} of ${dueAts.length} reminders for "${title}".`,
        );
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
      // Win Celebration — same dopamine moment as completing from the list.
      onReminderCompleted?.(target);
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

    if (action.type === "edit_reminder") {
      const hasPayload =
        action.newTitle || action.newNotes !== undefined ||
        action.newPriority !== undefined || action.newDomain !== undefined ||
        action.newRecurrence !== undefined || action.newLinkedTaskId !== undefined ||
        action.newStatus !== undefined;
      if (!hasPayload) {
        void refreshReminders();
        return;
      }
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) {
        // Server (Phase 1A) may have already applied the edit; refresh to show updated state
        void refreshReminders();
        return;
      }
      // Build patch — title/notes/recurrence require priority in body
      const patch: Record<string, unknown> = {};
      if (action.newTitle) patch.title = action.newTitle;
      if (typeof action.newNotes === "string") patch.notes = action.newNotes;
      if (action.newRecurrence !== undefined) patch.recurrence = action.newRecurrence;
      if (action.newPriority !== undefined) patch.priority = action.newPriority;
      if (action.newDomain !== undefined) patch.domain = action.newDomain; // null clears it
      if (action.newLinkedTaskId !== undefined) patch.linkedTaskId = action.newLinkedTaskId; // null delinks
      if (action.newStatus !== undefined) patch.status = action.newStatus;
      // priority is REQUIRED when updating title, notes, or recurrence
      if ((patch.title !== undefined || patch.notes !== undefined || patch.recurrence !== undefined) && patch.priority === undefined) {
        patch.priority = typeof target.priority === "number" ? target.priority : 3;
      }
      // Optimistic: apply changes locally immediately
      optimisticUpdateReminder((prev) =>
        prev.map((r) => {
          if (r.id !== target.id) return r;
          return {
            ...r,
            ...(action.newTitle ? { title: action.newTitle } : {}),
            ...(typeof action.newNotes === "string" ? { notes: action.newNotes } : {}),
            ...(action.newPriority !== undefined ? { priority: action.newPriority } : {}),
            ...(action.newDomain !== undefined ? { domain: (action.newDomain ?? undefined) as import("@repo/reminder").LifeDomain | undefined } : {}),
            ...(action.newRecurrence !== undefined ? { recurrence: action.newRecurrence } : {}),
            ...(action.newLinkedTaskId !== undefined ? { linkedTaskId: action.newLinkedTaskId ?? undefined } : {}),
            ...(action.newStatus !== undefined ? { status: action.newStatus } : {}),
          };
        }),
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
      const newDueAt = new Date(action.dueAt).getTime();
      // Optimistic: update due time immediately so the card moves to the right bucket
      // without waiting for the PATCH to return (mirrors the snooze_reminder pattern).
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
        showShareToast("Could not reschedule reminder. Try again.");
        void refreshReminders(); // rollback to server state
      });
      return;
    }

    // ─── Task CRUD handlers ───────────────────────────────────────────────────

    if (action.type === "create_task" && action.title) {
      const title = action.title;
      void (async () => {
        const validDomains = ["health", "finance", "career", "hobby", "fun"] as const;
        try {
          const res = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              notes: action.notes?.trim() ? action.notes : undefined,
              priority:
                typeof action.priority === "number" && action.priority >= 1 && action.priority <= 5
                  ? action.priority
                  : 3,
              domain: validDomains.includes(action.domain as typeof validDomains[number])
                ? action.domain
                : undefined,
              status: "pending",
            }),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            showShareToast(data.error ?? "Could not save the task. Please try again.");
            return;
          }
          await refreshTasks();
        } catch {
          showShareToast("Could not save the task. Please try again.");
        }
      })();
      return;
    }

    if (action.type === "mark_task_done") {
      if (!action.targetId) {
        showShareToast("Couldn't find that task.");
        void refreshTasks();
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/tasks/${action.targetId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done" }),
          });
          if (!res.ok) {
            showShareToast("Could not complete task. Try again.");
          }
          await refreshTasks();
        } catch {
          showShareToast("Could not complete task. Try again.");
          void refreshTasks();
        }
      })();
      return;
    }

    if (action.type === "delete_task") {
      if (!action.targetId) {
        showShareToast("Couldn't find that task.");
        void refreshTasks();
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/tasks/${action.targetId}`, { method: "DELETE" });
          if (!res.ok) {
            showShareToast("Could not delete task. Try again.");
          } else {
            // Linked reminders are unlinked server-side; refresh to reflect
            const data = (await res.json().catch(() => ({}))) as { unlinkedReminderCount?: number };
            if (data.unlinkedReminderCount && data.unlinkedReminderCount > 0) {
              void refreshReminders();
            }
          }
          await refreshTasks();
        } catch {
          showShareToast("Could not delete task. Try again.");
          void refreshTasks();
        }
      })();
      return;
    }

    if (action.type === "edit_task") {
      const hasPayload =
        action.newTitle || action.newNotes !== undefined ||
        action.newPriority !== undefined || action.newDomain !== undefined;
      if (!hasPayload || !action.targetId) {
        void refreshTasks();
        return;
      }
      void (async () => {
        try {
          // Build patch — PATCH /api/tasks/[id] requires priority when updating title or notes
          const patch: Record<string, unknown> = {};
          if (action.newTitle) patch.title = action.newTitle;
          if (typeof action.newNotes === "string") patch.notes = action.newNotes;
          if (action.newPriority !== undefined) patch.priority = action.newPriority;
          if (action.newDomain !== undefined) patch.domain = action.newDomain; // null clears it
          // priority is REQUIRED when updating title or notes
          if ((patch.title !== undefined || patch.notes !== undefined) && patch.priority === undefined) {
            const taskRow = tasks.find((t) => t.id === action.targetId);
            patch.priority = typeof taskRow?.priority === "number" ? taskRow.priority : 3;
          }
          const res = await fetch(`/api/tasks/${action.targetId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          if (!res.ok) {
            showShareToast("Could not edit task. Try again.");
          }
          await refreshTasks();
        } catch {
          showShareToast("Could not edit task. Try again.");
          void refreshTasks();
        }
      })();
      return;
    }

    if (action.type === "list_tasks") {
      // list_tasks is display-only — the reply already contains the formatted list.
      // No mutation needed; nothing to do.
      return;
    }

    if (action.type === "pending_confirm" && action.pendingType) {
      setPendingConfirmAction({
        type: action.pendingType,
        targetId: action.targetId,
        targetTitle: action.targetTitle,
        targetIds: action.bulkTargetIds,
        // edit_reminder / edit_task confirmation carries the new field values
        newTitle: action.newTitle,
        newNotes: action.newNotes,
        newPriority: action.newPriority,
        newDomain: action.newDomain,
        newRecurrence: action.newRecurrence,
        newLinkedTaskId: action.newLinkedTaskId,
      });
      return;
    }

    // Gap 7: store listed IDs so the next turn can use ordinal references
    // (cleared at the top of applyAction for every non-list action)
    if (action.type === "list_reminders" && action.listedIds?.length) {
      setRecentListedIds(action.listedIds);
    }

    if (action.type === "clarify") {
      // Smart-create clarify: the server asked ONE question (e.g. "when does your
      // exam start and end?"). Remember the original request so the next message
      // is sent as the answer (single round — cleared on next submit).
      if (action.clarifyForReminder?.originalMessage) {
        pendingClarifyRef.current = action.clarifyForReminder;
        setPendingCreateDraft(null);
        setPendingDisambig(null);
        return;
      }
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
      // "Which reminder should I reschedule/edit?" with no candidates yet — server
      // is waiting for the user to name one. Never trigger the create wizard here.
      if (action.pendingOp === "reschedule" || action.pendingOp === "edit" ||
          action.pendingOp === "mark_done" || action.pendingOp === "delete" || action.pendingOp === "snooze") {
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

          // The system NEVER auto-applies the change — even after the user picks
          // which reminder they meant. Show the matched reminder as a PREFILLED
          // card (micro front-end); the user commits via Save. Nothing mutates here.
          const cardMeta: ChatMessageMeta = (() => {
            const base = { kind: "reminder_card" as const, reminderIds: [match.id], totalListedCount: 1 };
            if (disambigSnapshot.op === "reschedule") {
              return { ...base, cardMode: "reschedule" as const, cardPrefill: { dueAt: disambigSnapshot.pendingDueAt } };
            }
            if (disambigSnapshot.op === "snooze") {
              const dueAt = new Date(Date.now() + disambigSnapshot.pendingDelayMinutes * 60_000).toISOString();
              return { ...base, cardMode: "reschedule" as const, cardPrefill: { dueAt } };
            }
            if (disambigSnapshot.op === "edit") {
              const { pendingField, pendingValue } = disambigSnapshot;
              const cp: NonNullable<ChatMessageMeta["cardPrefill"]> = {};
              if (pendingField === "title") cp.title = pendingValue;
              else if (pendingField === "notes") cp.notes = pendingValue;
              else if (pendingField === "priority") cp.priority = parseInt(pendingValue, 10) || 3;
              else if (pendingField === "domain") cp.domain = pendingValue || null;
              else if (pendingField === "recurrence") cp.recurrence = (pendingValue as "none" | "daily" | "weekly" | "monthly") || "none";
              return { ...base, cardMode: "edit" as const, cardPrefill: cp };
            }
            // mark_done / delete → default card (its own Done / Delete buttons).
            return base;
          })();

          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: `here's "${match.title}" — review and save (nothing's changed yet).`,
              createdAt: new Date().toISOString(),
            },
            {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              content: "",
              createdAt: new Date().toISOString(),
              meta: cardMeta,
            },
          ]);
          return;
        }

        // ── Create-wizard escape hatch ──────────────────────────────────────────
        // Any CRUD intent (done / delete / reschedule / edit) while in a structured
        // step means the user pivoted to a different task. Clear the draft and let
        // the message fall through to normal processing. Title step is exempt because
        // any text is a valid reminder title there.
        const skipWizardForCrud =
          pendingCreateDraft !== null &&
          pendingCreateDraft.step !== "title" &&
          (looksLikeMarkDoneIntent(messageText.trim()) ||
            looksLikeDeleteIntent(messageText.trim()) ||
            looksLikeRescheduleIntent(messageText.trim()) ||
            looksLikeEditIntent(messageText.trim()));
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

        // One-round smart-create clarify: send (and clear) the pending original
        // request so this message is treated as the answer.
        const clarifySnapshot = pendingClarifyRef.current;
        pendingClarifyRef.current = null;
        // Conversational edit/cancel: send (and clear) the last created reminder ID.
        const lastCreatedIdSnapshot = lastCreatedIdRef.current;
        lastCreatedIdRef.current = null;

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
            ...(clarifySnapshot ? { pendingClarify: clarifySnapshot } : {}),
            ...(recentListedIds.length > 0 ? { recentListedIds } : {}),
            ...(lastCreatedIdSnapshot ? { lastCreatedId: lastCreatedIdSnapshot } : {}),
          }),
        });

        const data = (await response.json()) as AgentResponse;
        applyAction(data.action);

        // ── Build reminder-card meta for non-create actions ───────────────
        // create_reminder injects its card asynchronously (after the API call)
        // so it is excluded here. delete_reminder is also excluded — the reminder
        // is gone so there is nothing useful to show.
        const cardMeta = (() => {
          const a = data.action;
          if (a.type === "list_reminders" && a.listedIds?.length) {
            return {
              kind: "reminder_card" as const,
              reminderIds: a.listedIds.slice(0, 5),
              totalListedCount: a.listedIds.length,
            };
          }
          if (
            a.targetId &&
            (a.type === "edit_reminder" ||
              a.type === "reschedule_reminder" ||
              a.type === "snooze_reminder" ||
              a.type === "mark_done" ||
              a.type === "delete_reminder")
          ) {
            const base = { kind: "reminder_card" as const, reminderIds: [a.targetId], totalListedCount: 1 };
            // Non-preview (legacy) actions just show a live card. Preview actions
            // open the card prefilled in the right mode so the user only taps Save.
            if (!a.preview) return base;
            if (a.type === "reschedule_reminder") {
              // Open the reschedule card. Prefill the new time when the message
              // specified one; otherwise the card opens at the reminder's current
              // time for the user to pick.
              return {
                ...base,
                cardMode: "reschedule" as const,
                ...(a.dueAt ? { cardPrefill: { dueAt: a.dueAt } } : {}),
              };
            }
            if (a.type === "snooze_reminder" && typeof a.delayMinutes === "number") {
              return {
                ...base,
                cardMode: "reschedule" as const,
                cardPrefill: { dueAt: new Date(Date.now() + a.delayMinutes * 60_000).toISOString() },
              };
            }
            if (a.type === "edit_reminder") {
              return {
                ...base,
                cardMode: "edit" as const,
                cardPrefill: {
                  ...(a.newTitle !== undefined ? { title: a.newTitle } : {}),
                  ...(a.newNotes !== undefined ? { notes: a.newNotes } : {}),
                  ...(a.newPriority !== undefined ? { priority: a.newPriority } : {}),
                  ...(a.newDomain !== undefined ? { domain: a.newDomain } : {}),
                  ...(a.newRecurrence !== undefined ? { recurrence: a.newRecurrence } : {}),
                },
              };
            }
            // mark_done / delete_reminder → default mode; the card's own
            // Done / Delete buttons are the micro front-end for those.
            return base;
          }
          return null;
        })();

        const newMessages: ChatMessage[] = [
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.reply || "Done.",
            createdAt: new Date().toISOString(),
          },
          ...(cardMeta
            ? [{
                id: crypto.randomUUID(),
                role: "assistant" as const,
                content: "",
                createdAt: new Date().toISOString(),
                meta: cardMeta,
              }]
            : []),
        ];
        setMessages((prev) => [...prev, ...newMessages]);
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
