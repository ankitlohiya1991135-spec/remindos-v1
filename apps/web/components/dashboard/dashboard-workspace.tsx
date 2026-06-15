"use client";

import {
  buildBriefingParts,
  getReminderBucket,
  type BriefingSection,
  type FollowUpQuestion,
  type LifeDomain,
  type TaskItemBrief,
  type ReminderItem,
} from "@repo/reminder";
import { useUser, useClerk } from "@clerk/nextjs";
import { canAccessAdmin, getRoleFromPublicMetadata } from "@repo/admin";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { StarRating, priorityStarsLabel } from "./star-rating";
import { pickWinCopy, isLongPending, type WinCopy } from "./win-copy";
import { StructuredMessage } from "./structured-message";
import {
  TaskFormOverlay,
  TaskListOverlay,
  type TaskRow,
} from "./task-panels";
import { WalkthroughOverlay } from "./walkthrough-overlay";
import {
  showCollaborationNotification,
  shouldNotifyForCollaboration,
} from "../../lib/collaboration-notifications";
import type { ReplyContextPayload } from "../../lib/chat-reply-context";
import type { DueNotificationPrefs } from "../../lib/reminder-notification-prefs";
import { playPreDuePing, playOverdueNudge } from "../../lib/notification-sounds";
import { ChatBubbleShell } from "./chat-bubble-shell";
import { SnapshotOverlay } from "./snapshot-overlay";
import { BottomNav } from "./bottom-nav";
import { ChatPanelHeader } from "./chat-panel-header";
import { NotificationPrefsPanel } from "../notifications/notification-prefs-panel";
import { ShareOverlay } from "./share-overlay";
import { ReminderCard } from "./reminder-card";
import { ImportOverlay } from "./import-overlay";
import { BatchOverlay } from "./batch-overlay";
import { CreateReminderOverlay } from "./create-reminder-overlay";
import { ReminderListOverlay, type GroupedReminders } from "./reminder-list-overlay";
import { TaskWarningModal } from "./task-warning-modal";
import { DeleteReminderConfirm } from "./delete-reminder-confirm";
import { RescheduleReminderModal, type RescheduleReminderState } from "./reschedule-reminder-modal";
import { DesktopPanel } from "./desktop-panel";
import { ChatPanel } from "./chat-panel";
import { useChatEngine } from "./use-chat-engine";
import { useDashboardOverlays } from "./use-dashboard-overlays";
import { useTaskFormState } from "./use-task-form-state";
import { useBatchRunner } from "./use-batch-runner";
import { useDueNotifications } from "./use-due-notifications";
import { useChatSync } from "./use-chat-sync";
import { useChatSideEffects } from "./use-chat-side-effects";

// ─── Types — see ./dashboard-types.ts ─────────────────────────────────────
import type {
  ChatRole,
  ChatReplyToRef,
  ChatMessageMeta,
  ChatMessage,
  AgentAction,
  AgentResponse,
  PendingCreateDraft,
  PendingConfirmAction,
  PendingDisambig,
  PendingTimeSuggestion,
  WorkspaceProps,
  TaskWarningAction,
  ReminderListTab,
} from "./dashboard-types";
// Re-export so existing consumers (snapshot-overlay, chat-panel-header, bottom-nav) keep working
export type { ReminderListTab };

// ─── Utils — see ./dashboard-utils.ts ──────────────────────────────────────
import {
  SHOW_SUGGESTED_QUESTIONS_KEY,
  DEFAULT_CHAT_REMINDER_TITLE,
  STARTER_MESSAGE,
  loadingTexts,
  clearChatBackup,
  toReplyContextPayload,
  chatReplyLabel,
  briefingSectionLabel,
  formatSummaryTime,
  formatDisplayDateTime,
  toDateTimeLocalValue,
  currentDateTimeLocalValue,
  fromApiReminder,
  matchesReminder,
  isNextTwoHoursReminder,
  reminderStateLabel,
  fromApiTask,
  taskBucket,
  directoryDisplayName,
  parseLifeDomain,
  LIFE_DOMAINS,
  extractCreateTitle,
  hasInlineCreateDetails,
  parseDateInput,
  parseTimeInput,
} from "./dashboard-utils";

function usePersistentReminders(userId: string) {
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setReminders([]);
    setIsLoaded(false);
    const load = async () => {
      try {
        const response = await fetch("/api/reminders");
        if (!response.ok) throw new Error("Failed to load reminders");
        const data = (await response.json()) as {
          reminders?: Array<Record<string, unknown>>;
        };
        const parsed = (data.reminders ?? []).map((item) =>
          fromApiReminder(item),
        );
        setReminders(parsed);
      } catch {
        setReminders([]);
      } finally {
        setIsLoaded(true);
      }
    };
    void load();
  }, [userId]);

  const updateReminders = (
    updater: (prev: ReminderItem[]) => ReminderItem[],
  ) => {
    setReminders((prev) => {
      return updater(prev);
    });
  };

  return [reminders, updateReminders, isLoaded] as const;
}

export function DashboardWorkspace({ userId }: WorkspaceProps) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const searchParams = useSearchParams();
  const notifUrlHandledRef = useRef<string | null>(null);
  const [reminders, setReminders, remindersLoaded] = usePersistentReminders(userId);
  const [mounted, setMounted] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isClearingChat, setIsClearingChat] = useState(false);
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);
  const [pendingCreateDraft, setPendingCreateDraft] =
    useState<PendingCreateDraft | null>(null);
  const [pendingConfirmAction, setPendingConfirmAction] =
    useState<PendingConfirmAction | null>(null);
  /** Tracks an in-progress disambiguation: user was asked "which one?" for any CRUD op */
  const [pendingDisambig, setPendingDisambig] = useState<PendingDisambig | null>(null);
  const [recentListedIds, setRecentListedIds] = useState<string[]>([]);
  const [pendingTimeSuggestion, setPendingTimeSuggestion] = useState<PendingTimeSuggestion | null>(null);
  const [showReminderSuccess, setShowReminderSuccess] = useState(false);
  const [reminderSuccessInfo, setReminderSuccessInfo] = useState<{ title: string; time: string } | null>(null);
  // Win Celebration — gentle in-app dopamine moment when a reminder is completed.
  const [winCopy, setWinCopy] = useState<WinCopy | null>(null);
  const winTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState<FollowUpQuestion[]>([]);
  const [showSuggestedQuestions, setShowSuggestedQuestions] = useState(true);
  const [reminderListTabDesktop, setReminderListTabDesktop] = useState<ReminderListTab>("missed");
  const [reminderSearchQuery, setReminderSearchQuery] = useState("");
  const [pendingReminderCardDelete, setPendingReminderCardDelete] =
    useState<{ id: string; title: string } | null>(null);
  const [rescheduleReminder, setRescheduleReminder] = useState<RescheduleReminderState | null>(null);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const shareToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reminderSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Phase 2A: 5-second undo queue for mark-done and delete. */
  const [pendingUndoAction, setPendingUndoAction] = useState<{
    type: "done" | "delete";
    reminder: ReminderItem;
  } | null>(null);
  const pendingUndoRef = useRef<{ type: "done" | "delete"; reminder: ReminderItem } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** DOM timer id; avoid NodeJS.Timeout vs number mismatch in mixed typings. */
  const reminderLongPressTimerRef = useRef<number | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const briefingRanRef = useRef(false);
  const openingSummaryAppliedRef = useRef(false);
  const missedRemindersAppliedRef = useRef(false);
  const resetTaskFormRef = useRef<() => void>(() => {});
  const briefingPlaybackActiveRef = useRef(false);
  // Forward ref so flushChatHistoryToServer (in useChatSync) can call showShareToast
  const showShareToastRef = useRef<((msg: string) => void) | null>(null);
  const remindersRef = useRef(reminders);
  remindersRef.current = reminders;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [briefingStreaming, setBriefingStreaming] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const quickSubmitTextRef = useRef<string | null>(null);
  /** When false, do not auto-scroll on new/streaming content so the user can read history. */
  const chatPinnedToBottomRef = useRef(true);
  /** After clear chat, ignore poll merges briefly so in-flight GETs cannot restore deleted history. */
  const skipRemotePollMergeUntilRef = useRef(0);

  messagesRef.current = messages;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("dashboard:reminders-changed", {
        detail: {
          reminders: reminders.map((reminder) => ({
            id: reminder.id,
            dueAt: reminder.dueAt,
            status: reminder.status,
          })),
        },
      }),
    );
  }, [reminders]);

  // Sync the suggested-questions toggle from the AppDrawer in real time.
  // AppDrawer writes localStorage and dispatches this event; we update
  // the in-memory state so the chat panel reflects the change immediately
  // without requiring a page reload.
  useEffect(() => {
    const handler = (e: Event) => {
      const on = (e as CustomEvent<boolean>).detail;
      setShowSuggestedQuestions(on);
    };
    window.addEventListener("dashboard:suggested-questions-toggle", handler);
    return () => window.removeEventListener("dashboard:suggested-questions-toggle", handler);
  }, []);

  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    chatPinnedToBottomRef.current = gap <= 120;
  }, []);


  // ─── Chat sync (history load, persist, poll) ─────────────────────────────
  const { isHistoryLoaded, flushChatHistoryToServer } = useChatSync({
    userId,
    messages,
    isLoading,
    briefingStreaming,
    setMessages,
    showShareToastRef,
    messagesRef,
    skipRemotePollMergeUntilRef,
  });

  // ─── Due notifications ────────────────────────────────────────────────────
  const {
    dueNotifPrefs,
    setDueNotifPrefs,
    dueNotifBannerDismissed,
    persistDueNotifPrefs,
    requestDueNotificationPermission,
    dismissDueNotifBanner,
  } = useDueNotifications({
    isHistoryLoaded,
    reminders,
    setMessages,
  });

  // Allow the layout-level AppDrawer to trigger notification permission requests
  // by dispatching "dashboard:request-notification-permission".
  useEffect(() => {
    const handler = () => { void requestDueNotificationPermission(); };
    window.addEventListener("dashboard:request-notification-permission", handler);
    return () => window.removeEventListener("dashboard:request-notification-permission", handler);
  }, [requestDueNotificationPermission]);

  const runBriefingStream = useCallback(
    (recordAutoBriefing = false) => {
      if (!isHistoryLoaded || briefingPlaybackActiveRef.current) return;
      briefingPlaybackActiveRef.current = true;
      setBriefingStreaming(true);
      chatPinnedToBottomRef.current = true;

      const taskBrief: TaskItemBrief[] = tasksRef.current.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: t.dueAt,
        status: t.status,
        priority: t.priority,
      }));
      const parts = buildBriefingParts(
        remindersRef.current,
        user?.firstName ?? null,
        taskBrief,
      );

      setMessages((prev) =>
        prev.filter((m) => m.id !== "starter" && m.meta?.kind !== "briefing"),
      );

      setMessages((prev) => [
        ...prev,
        ...parts.map((part, index) => ({
          id: `briefing-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`,
          role: "assistant" as const,
          content: part.text,
          createdAt: new Date().toISOString(),
          meta: {
            kind: "briefing" as const,
            briefingSection: part.section,
            skipPersist: true,
          },
        })),
      ]);

      briefingPlaybackActiveRef.current = false;
      setBriefingStreaming(false);
      if (recordAutoBriefing) {
        try {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem(
              `remindos:lastAutoBriefingAt:${userId}`,
              String(Date.now()),
            );
          }
        } catch {
          /* ignore */
        }
      }
    },
    [isHistoryLoaded, user?.firstName, userId],
  );

  const refreshReminders = useCallback(async () => {
    const response = await fetch("/api/reminders");
    if (!response.ok) return;
    const data = (await response.json()) as {
      reminders?: Array<Record<string, unknown>>;
    };
    setReminders(() =>
      (data.reminders ?? []).map((item) => fromApiReminder(item)),
    );
  }, [setReminders]);

  const showShareToast = useCallback((message: string) => {
    setShareToast(message);
    if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current);
    shareToastTimerRef.current = setTimeout(() => {
      setShareToast(null);
      shareToastTimerRef.current = null;
    }, 3400);
  }, []);
  // Keep ref in sync so flushChatHistoryToServer (defined earlier) can call it
  showShareToastRef.current = showShareToast;

  const refreshAfterReminderMutation = useCallback(
    async (responsePromise: Promise<Response>) => {
      const response = await responsePromise;
      if (!response.ok) {
        throw new Error("Reminder update failed");
      }
      await refreshReminders();
    },
    [refreshReminders],
  );

  /**
   * Optimistically update local reminder state BEFORE an API call resolves.
   * Accepts the same updater signature as React's setState so callers can
   * splice, filter, or map the array cleanly.
   * On API failure, callers should invoke refreshReminders() to roll back.
   */
  const optimisticUpdateReminder = useCallback(
    (updater: (prev: ReminderItem[]) => ReminderItem[]) => {
      setReminders(updater);
    },
    [setReminders],
  );

  // ── Phase 2A: undo queue for Done + Delete ─────────────────────────────────

  /** Commit (execute) the pending undo action immediately. */
  const commitPendingUndo = useCallback(async (action: { type: "done" | "delete"; reminder: ReminderItem }) => {
    try {
      if (action.type === "done") {
        await fetch(`/api/reminders/${action.reminder.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });
      } else {
        await fetch(`/api/reminders/${action.reminder.id}`, { method: "DELETE" });
      }
      await refreshReminders();
    } catch {
      // Rollback optimistic update on failure
      optimisticUpdateReminder((prev) => {
        if (action.type === "done") {
          return prev.map((r) => r.id === action.reminder.id ? { ...r, status: "pending" as const } : r);
        }
        const exists = prev.find((r) => r.id === action.reminder.id);
        return exists ? prev : [...prev, action.reminder];
      });
      showShareToast("Could not complete action. Try again.");
    }
  }, [refreshReminders, optimisticUpdateReminder, showShareToast]);

  /** Queue a Done or Delete with a 5-second undo window. */
  /** Win Celebration — a gentle dopamine moment on completion (any path);
   *  extra warmth for long-pending clears. */
  const celebrateCompletion = useCallback((reminder: ReminderItem) => {
    if (winTimerRef.current) clearTimeout(winTimerRef.current);
    setWinCopy(pickWinCopy({ longPending: isLongPending(reminder.createdAt) }));
    winTimerRef.current = setTimeout(() => {
      setWinCopy(null);
      winTimerRef.current = null;
    }, 2800);
  }, []);

  const triggerUndoAction = useCallback((type: "done" | "delete", reminder: ReminderItem) => {
    // If there is already a queued action, commit it immediately before replacing
    if (pendingUndoRef.current && undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
      void commitPendingUndo(pendingUndoRef.current);
    }
    // Optimistic update
    if (type === "done") {
      optimisticUpdateReminder((prev) =>
        prev.map((r) => r.id === reminder.id ? { ...r, status: "done" as const } : r),
      );
      celebrateCompletion(reminder);
    } else {
      optimisticUpdateReminder((prev) => prev.filter((r) => r.id !== reminder.id));
    }
    pendingUndoRef.current = { type, reminder };
    setPendingUndoAction({ type, reminder });
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      const pending = pendingUndoRef.current;
      if (pending) {
        pendingUndoRef.current = null;
        setPendingUndoAction(null);
        void commitPendingUndo(pending);
      }
    }, 5000);
  }, [commitPendingUndo, optimisticUpdateReminder, celebrateCompletion]);

  /** Cancel the pending undo action and restore the reminder. */
  const cancelUndoAction = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    const action = pendingUndoRef.current;
    pendingUndoRef.current = null;
    setPendingUndoAction(null);
    if (!action) return;
    if (action.type === "done") {
      optimisticUpdateReminder((prev) =>
        prev.map((r) => r.id === action.reminder.id ? { ...r, status: "pending" as const } : r),
      );
    } else {
      optimisticUpdateReminder((prev) => {
        const exists = prev.find((r) => r.id === action.reminder.id);
        return exists ? prev : [...prev, action.reminder].sort(
          (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
        );
      });
    }
  }, [optimisticUpdateReminder]);

  const playReminderSuccessAnimation = useCallback((info?: { title: string; time: string }) => {
    setShowReminderSuccess(true);
    if (info) setReminderSuccessInfo(info);
    if (reminderSuccessTimerRef.current)
      clearTimeout(reminderSuccessTimerRef.current);
    reminderSuccessTimerRef.current = setTimeout(() => {
      setShowReminderSuccess(false);
      setReminderSuccessInfo(null);
      reminderSuccessTimerRef.current = null;
    }, 2200);
  }, []);


  const refreshRemindersRef = useRef(refreshReminders);
  refreshRemindersRef.current = refreshReminders;

  const refreshTasks = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks");
      if (!response.ok) return;
      const data = (await response.json()) as {
        tasks?: Array<Record<string, unknown>>;
      };
      setTasks((data.tasks ?? []).map((item) => fromApiTask(item)));
    } finally {
      setTasksLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [userId, refreshTasks]);




  useEffect(() => {
    try {
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem(SHOW_SUGGESTED_QUESTIONS_KEY) === "0"
      ) {
        setShowSuggestedQuestions(false);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const runReminderQuickAction = useCallback(
    async (reminderId: string, action: "delete" | "done" | "snooze") => {
      if (action === "delete") {
        // Phase 2A: undo queue instead of confirmation dialog
        const reminder = reminders.find((r) => r.id === reminderId);
        if (reminder) { triggerUndoAction("delete", reminder); return; }
        // Fallback: show confirmation dialog if reminder not found in local state
        setPendingReminderCardDelete({ id: reminderId, title: "this reminder" });
        return;
      } else if (action === "done") {
        // Phase 2A: undo queue instead of immediate API call
        const reminder = reminders.find((r) => r.id === reminderId);
        if (reminder) { triggerUndoAction("done", reminder); return; }
        // Fallback: direct call if not found locally
        await refreshAfterReminderMutation(
          fetch(`/api/reminders/${reminderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done" }),
          }),
        );
      } else {
        await refreshAfterReminderMutation(
          fetch(`/api/reminders/${reminderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dueAt: Date.now() + 60 * 60 * 1000 }),
          }),
        );
      }
    },
    [refreshAfterReminderMutation, reminders, triggerUndoAction],
  );

  useEffect(() => {
    if (!isLoading) return;
    const interval = window.setInterval(() => {
      setLoadingTextIndex((prev) => (prev + 1) % loadingTexts.length);
    }, 2200);
    return () => window.clearInterval(interval);
  }, [isLoading]);

  useEffect(() => {
    return () => {
      if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current);
      if (reminderSuccessTimerRef.current) clearTimeout(reminderSuccessTimerRef.current);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  useEffect(() => {
    briefingRanRef.current = false;
    openingSummaryAppliedRef.current = false;
    missedRemindersAppliedRef.current = false;
    setTasksLoaded(false);
  }, [userId]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const maxHeight = Math.min(window.innerHeight * 0.28, 144);
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, 44)}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input, briefingStreaming, editingMessageId, replyTarget]);

  const inviteQueryParam = searchParams?.get("invite");

  useEffect(() => {
    const token = inviteQueryParam?.trim();
    if (!token || !isHistoryLoaded) return;

    const handledKey = `remindos:inviteUiHandled:${token}`;
    if (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem(handledKey)
    ) {
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", "/dashboard");
      }
      return;
    }

    // Strip ?invite= from the URL immediately so this effect does not re-fire in a loop
    // (each run would otherwise append another error/success message).
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", "/dashboard");
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/reminders/share/${encodeURIComponent(token)}`,
          {
            method: "POST",
          },
        );
        const data = (await res.json()) as { error?: string; title?: string };
        if (cancelled) return;

        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(handledKey, "1");
        }

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

        await refreshRemindersRef.current();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.title
              ? `You're in on "${data.title}". Shared reminders appear in your list.`
              : "Invite accepted.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch {
        if (!cancelled) {
          if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem(handledKey, "1");
          }
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content:
                "Could not accept the invite. Try again from chat with the link.",
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inviteQueryParam, isHistoryLoaded]);

  useEffect(() => {
    if (!isHistoryLoaded) return;
    for (const m of messages) {
      if (m.role !== "system") continue;
      if (!/\bwas accepted by\b|\byou joined\b/i.test(m.content)) continue;
      if (!shouldNotifyForCollaboration(m.id, m.createdAt)) continue;
      const title = /\bwas accepted by\b/i.test(m.content)
        ? "Reminder shared"
        : "Shared reminder";
      void showCollaborationNotification(
        title,
        m.content.slice(0, 200),
        `collab-${m.id}`,
      );
    }
  }, [messages, isHistoryLoaded]);

  useEffect(() => {
    const rid = searchParams?.get("reminderId")?.trim();
    const act = searchParams?.get("notifAction")?.trim();
    if (!rid) return;
    const sig = `${act ?? ""}:${rid}`;
    if (notifUrlHandledRef.current === sig) return;
    if (!act || act === "open") {
      notifUrlHandledRef.current = sig;
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", "/dashboard");
      }
      return;
    }
    if (act !== "done" && act !== "snooze" && act !== "delete") return;
    notifUrlHandledRef.current = sig;
    void runReminderQuickAction(rid, act).finally(() => {
      const reminderTitle = remindersRef.current.find((r) => r.id === rid)?.title ?? "Reminder";
      const resolutionLine =
        act === "done"
          ? `Marked "${reminderTitle}" as done.`
          : act === "snooze"
            ? `Snoozed "${reminderTitle}" by one hour.`
            : `Deleted "${reminderTitle}".`;
      resolveDueReminderById(rid, resolutionLine);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content:
            act === "done"
              ? `Marked **${reminderTitle}** as done from notification.`
              : act === "snooze"
                ? `Snoozed **${reminderTitle}** for 1 hour from notification.`
                : `Deleted **${reminderTitle}** from notification.`,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", "/dashboard");
      }
    });
  }, [searchParams, runReminderQuickAction]);

  const grouped = useMemo(() => {
    const now = new Date();
    const tz = typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined;
    const next = {
      missed: [] as ReminderItem[],
      today: [] as ReminderItem[],
      tomorrow: [] as ReminderItem[],
      upcoming: [] as ReminderItem[],
      done: [] as ReminderItem[],
    };

    for (const reminder of reminders) {
      const bucket = getReminderBucket(reminder, now, tz);
      if (bucket === "missed") {
        next.missed.push(reminder);
        continue;
      }
      if (bucket === "today") next.today.push(reminder);
      else if (bucket === "tomorrow") next.tomorrow.push(reminder);
      else if (bucket === "upcoming") next.upcoming.push(reminder);
      else if (bucket === "done") next.done.push(reminder);
    }

    return {
      missed: next.missed,
      today: next.today,
      tomorrow: next.tomorrow,
      upcoming: next.upcoming,
      done: next.done,
    };
  }, [reminders]);

  const snapshot = useMemo(
    () => ({
      pending: reminders.filter((r) => r.status !== "done").length,
      done: reminders.filter((r) => r.status === "done").length,
      missed: grouped.missed.length,
      today: grouped.today.length,
      tomorrow: grouped.tomorrow.length,
    }),
    [grouped.missed.length, grouped.today.length, grouped.tomorrow.length, reminders],
  );

  // Broadcast snapshot counts whenever they change so the AppDrawer can
  // display the same Missed / Today / Tomorrow / Later tiles without prop-drilling.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("dashboard:snapshot-update", { detail: snapshot }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.missed, snapshot.today, snapshot.tomorrow, snapshot.pending]);

  const nextTwoHoursReminders = useMemo(() => {
    const now = new Date();
    return reminders
      .filter((reminder) => isNextTwoHoursReminder(reminder, now))
      .slice()
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  }, [reminders]);

  const tasksGrouped = useMemo(() => {
    const now = new Date();
    const byPriDue = (a: TaskRow, b: TaskRow) => {
      const pa = typeof a.priority === "number" ? a.priority : 0;
      const pb = typeof b.priority === "number" ? b.priority : 0;
      if (pa !== pb) return pb - pa;
      const da = a.dueAt
        ? new Date(a.dueAt).getTime()
        : Number.MAX_SAFE_INTEGER;
      const db = b.dueAt
        ? new Date(b.dueAt).getTime()
        : Number.MAX_SAFE_INTEGER;
      return da - db;
    };
    return {
      missed: tasks
        .filter((t) => taskBucket(t, now) === "missed")
        .slice()
        .sort(byPriDue),
      pending: tasks
        .filter(
          (t) => t.status === "pending" && taskBucket(t, now) !== "missed",
        )
        .slice()
        .sort(byPriDue),
      done: tasks
        .filter((t) => t.status === "done")
        .slice()
        .sort(byPriDue),
    };
  }, [tasks]);

  const taskTitleById = useMemo(
    () => Object.fromEntries(tasks.map((t) => [t.id, t.title] as const)),
    [tasks],
  );

  const matchesReminderSearch = useCallback(
    (reminder: ReminderItem, query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const linkedTaskTitle = reminder.linkedTaskId
        ? taskTitleById[reminder.linkedTaskId] ?? ""
        : "";
      const hay = [
        reminder.title,
        reminder.notes ?? "",
        reminder.recurrence ?? "",
        reminder.domain ?? "",
        linkedTaskTitle,
        reminder.status,
        reminder.access ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    },
    [taskTitleById],
  );

  const { handleChatSubmit, applyAction } = useChatEngine({
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
    onReminderCompleted: celebrateCompletion,
    refreshAfterReminderMutation,
    showShareToast,
  });

  // ─── Batch question runner ────────────────────────────────────────────────
  const { runBatchQuestions } = useBatchRunner({
    applyAction,
    remindersRef,
    tasksRef,
    setMessages,
  });

  // ─── Chat side effects (follow-ups, opening summary, scroll, cue) ─────────
  useChatSideEffects({
    messages,
    reminders,
    tasks,
    isHistoryLoaded,
    isLoading,
    briefingStreaming,
    remindersLoaded,
    tasksLoaded,
    firstName: user?.firstName,
    setMessages,
    setFollowUpQuestions,
    chatScrollRef,
    chatPinnedToBottomRef,
    openingSummaryAppliedRef,
    missedRemindersAppliedRef,
  });

  const handleClearChat = async () => {
    if (isClearingChat) return;
    setIsClearingChat(true);
    try {
      const del = await fetch("/api/chat/history", { method: "DELETE" });
      if (!del.ok) {
        return;
      }
      clearChatBackup(userId);
      // Extend suppress window to 60s so in-flight polls from other tabs don't restore cleared history
      skipRemotePollMergeUntilRef.current = Date.now() + 60_000;
      setPendingCreateDraft(null);
      setPendingDisambig(null);
      setPendingConfirmAction(null);
      setPendingTimeSuggestion(null);
      setRecentListedIds([]);
      setReplyTarget(null);
      setEditingMessageId(null);
      const starter: ChatMessage = {
        ...STARTER_MESSAGE,
        createdAt: new Date().toISOString(),
      };
      setMessages([starter]);
      // Persist fresh thread on server so refresh and other tabs see the new baseline, not old history.
      await fetch("/api/chat/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              id: starter.id,
              role: starter.role,
              content: starter.content,
              createdAt: starter.createdAt,
            },
          ],
        }),
      });
    } finally {
      setIsClearingChat(false);
    }
  };

  const resolveDueLine = (messageId: string, line: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, meta: undefined, content: line } : m,
      ),
    );
  };

  const resolveDueReminderById = (reminderId: string, line: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.meta?.kind === "due_reminder" && m.meta.reminderId === reminderId
          ? { ...m, meta: undefined, content: line }
          : m,
      ),
    );
  };

  const handleDueReminderAction = async (
    messageId: string,
    reminderId: string,
    action: "delete" | "done" | "snooze" | "reschedule",
  ) => {
    const title =
      reminders.find((x) => x.id === reminderId)?.title ?? "Reminder";
    try {
      if (action === "delete") {
        await runReminderQuickAction(reminderId, "delete");
        resolveDueLine(messageId, `Deleted "${title}".`);
        resolveDueReminderById(reminderId, `Deleted "${title}".`);
        return;
      }
      if (action === "done") {
        await runReminderQuickAction(reminderId, "done");
        resolveDueLine(messageId, `Marked "${title}" as done.`);
        resolveDueReminderById(reminderId, `Marked "${title}" as done.`);
        return;
      }
      if (action === "snooze") {
        await runReminderQuickAction(reminderId, "snooze");
        resolveDueLine(messageId, `Snoozed "${title}" by one hour.`);
        resolveDueReminderById(reminderId, `Snoozed "${title}" by one hour.`);
        return;
      }
      const reminder = reminders.find((x) => x.id === reminderId);
      setRescheduleReminder({
        messageId,
        reminderId,
        title,
        value: toDateTimeLocalValue(reminder?.dueAt ?? new Date().toISOString()) || currentDateTimeLocalValue(),
        error: null,
      });
    } catch {
      resolveDueLine(messageId, `Something went wrong updating "${title}".`);
      resolveDueReminderById(
        reminderId,
        `Something went wrong updating "${title}".`,
      );
    }
  };

  const handleExportChat = () => {
    if (messages.length === 0) return;
    const lines = messages.map((message) => {
      const date = new Date(message.createdAt);
      const timestamp = date.toLocaleString();
      const sender =
        message.role === "user"
          ? "You"
          : message.role === "system"
            ? "Notice"
            : "RemindOS (System)";
      return `[${timestamp}] ${sender}: ${message.content}`;
    });
    const content = lines.join("\n\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;
    anchor.href = url;
    anchor.download = `remindos-chat-${stamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  // ─── Overlay, share, walkthrough management ───────────────────────────────
  const {
    isSnapshotOpen, isCreateOpen, isListOpen, isTasksOpen, isShareOpen,
    isImportOpen, isBatchOpen, isAnyOverlayOpen,
    editingReminder, setEditingReminder,
    reminderListInitialTab, reminderInitialLinkedTaskId, setReminderInitialLinkedTaskId,
    taskMode, setTaskMode, taskTab, setTaskTab, taskSearchQuery, setTaskSearchQuery,
    taskActionWarning, setTaskActionWarning,
    walkthroughOpen, walkthroughStepIndex, currentWalkthroughStep, walkthroughStepCount,
    advanceWalkthrough, closeWalkthrough,
    shareInbox, shareReminderIds, directoryUsers, directoryLoading, directoryError,
    selectedShareUserIds, shareSending,
    openShareModal, showShareOverlay, sendShares, toggleShareUser,
    joinShareBatch, dismissShareBatch, loadShareInbox,
    showSnapshotOverlay, showReminderListOverlay, showCreateOverlay, showTasksOverlay,
    showImportOverlay, showBatchOverlay,
    closeSnapshotOverlay, closeReminderListOverlay, closeCreateOverlay,
    closeTasksOverlay, closeShareOverlay, closeImportOverlay, closeBatchOverlay,
    closeAllDashboardOverlays,
    openEditModal, openAllTasksFromSnapshot, openNextTwoHoursFromSnapshot,
    openReminderListFromTasksPanel, openLinkedReminderForTask,
    setIsTasksOpen,
  } = useDashboardOverlays({
    userId,
    user,
    refreshTasks,
    resetTaskFormRef,
    tasksGrouped,
    showShareToast,
    refreshReminders,
    runBriefingStream,
    handleClearChat,
    handleExportChat,
  });


  // ─── Task form state & operations ────────────────────────────────────────
  const {
    taskFormTitle, setTaskFormTitle,
    taskFormDue, setTaskFormDue,
    taskFormNotes, setTaskFormNotes,
    taskFormError, setTaskFormError,
    taskStars, setTaskStars,
    editingTaskId, setEditingTaskId,
    taskFormDomain, setTaskFormDomain,
    taskDueUserEdited, setTaskDueUserEdited,
    getPendingLinkedReminderCount,
    executeTaskStatusToggle,
    executeTaskDelete,
    requestTaskStatusToggle,
    requestTaskDelete,
    confirmTaskWarning,
    resetTaskForm,
    openTaskEdit,
    handleTaskSave,
    startReminderForCurrentTask,
  } = useTaskFormState({
    reminders,
    refreshReminders,
    refreshTasks,
    showShareToast,
    showCreateOverlay,
    setIsTasksOpen,
    setTaskMode,
    taskActionWarning,
    setTaskActionWarning,
    resetTaskFormRef,
  });


  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const nav = navigator.serviceWorker;
    const handler = (event: MessageEvent) => {
      const d = event.data as {
        type?: string;
        action?: string;
        reminderId?: string;
        batchKey?: string;
        title?: string;
      };
      if (d?.type === "SHARE_INVITE_NOTIF" && d.batchKey) {
        const a = d.action ?? "open";
        if (a === "accept") void joinShareBatch(d.batchKey);
        else if (a === "deny") void dismissShareBatch(d.batchKey);
        return;
      }
      if (d?.type === "REMINDER_NOTIF") {
        const notifType = (d as { notifType?: string }).notifType;
        if (notifType === "pre_due_reminder" && dueNotifPrefs.soundEnabled !== false) playPreDuePing();
        if (notifType === "overdue_nudge" && dueNotifPrefs.soundEnabled !== false) playOverdueNudge();
      }
      if (d?.type !== "REMINDER_NOTIF" || !d.reminderId) return;
      const a = d.action ?? "open";
      if (a === "open") return;
      if (a === "done" || a === "snooze" || a === "delete") {
        const reminderId = d.reminderId;
        void runReminderQuickAction(reminderId, a).then(() => {
          const reminderTitle =
            remindersRef.current.find((r) => r.id === reminderId)?.title ??
            d.title ??
            "Reminder";
          const resolutionLine =
            a === "done"
              ? `Marked "${reminderTitle}" as done.`
              : a === "snooze"
                ? `Snoozed "${reminderTitle}" by one hour.`
                : `Deleted "${reminderTitle}".`;
          resolveDueReminderById(reminderId, resolutionLine);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content:
                a === "done"
                  ? `Marked **${reminderTitle}** as done from notification.`
                  : a === "snooze"
                    ? `Snoozed **${reminderTitle}** for 1 hour from notification.`
                    : `Deleted **${reminderTitle}** from notification.`,
              createdAt: new Date().toISOString(),
            },
          ]);
        });
      }
    };
    nav.addEventListener("message", handler);
    return () => nav.removeEventListener("message", handler);
  }, [runReminderQuickAction, joinShareBatch, dismissShareBatch]);

  const commitRescheduleReminder = useCallback(async () => {
    if (!rescheduleReminder) return;
    const dueMs = Date.parse(rescheduleReminder.value);
    if (!Number.isFinite(dueMs)) {
      setRescheduleReminder((prev) =>
        prev ? { ...prev, error: "Choose a valid date and time." } : prev,
      );
      return;
    }
    if (dueMs <= Date.now()) {
      setRescheduleReminder((prev) =>
        prev ? { ...prev, error: "Choose a future date and time." } : prev,
      );
      return;
    }

    const { messageId, reminderId, title } = rescheduleReminder;
    try {
      await refreshAfterReminderMutation(
        fetch(`/api/reminders/${reminderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueAt: dueMs }),
        }),
      );
      resolveDueLine(
        messageId,
        `Rescheduled "${title}" to ${new Date(dueMs).toLocaleString()}.`,
      );
      resolveDueReminderById(
        reminderId,
        `Rescheduled "${title}" to ${new Date(dueMs).toLocaleString()}.`,
      );
      setRescheduleReminder(null);
    } catch {
      showShareToast("Could not reschedule reminder. Try again.");
    }
  }, [refreshAfterReminderMutation, rescheduleReminder, showShareToast]);

  const openTaskReminderReschedule = useCallback(
    (reminder: ReminderItem) => {
      setRescheduleReminder({
        messageId: `task-view:${reminder.id}`,
        reminderId: reminder.id,
        title: reminder.title,
        value:
          toDateTimeLocalValue(reminder.dueAt) || currentDateTimeLocalValue(),
        error: null,
      });
    },
    [],
  );

  const handleTaskReminderAction = useCallback(
    (reminder: ReminderItem, action: "done" | "delete") => {
      void runReminderQuickAction(reminder.id, action).catch(() => {
        showShareToast("Could not update reminder. Try again.");
      });
    },
    [runReminderQuickAction, showShareToast],
  );


  /** Phase 2B: reschedule to today — keep same clock time or nudge 1h ahead if already past. */
  const handleRescheduleToday = useCallback((id: string) => {
    const reminder = reminders.find((r) => r.id === id);
    if (!reminder) return;
    const original = new Date(reminder.dueAt);
    const now = new Date();
    const todayTarget = new Date(now);
    todayTarget.setHours(original.getHours(), original.getMinutes(), 0, 0);
    const newDueAt = todayTarget.getTime() > now.getTime() ? todayTarget.getTime()
      : (() => {
          const bumped = new Date(now.getTime() + 60 * 60 * 1000);
          bumped.setMinutes(Math.ceil(bumped.getMinutes() / 15) * 15, 0, 0);
          return bumped.getTime();
        })();
    optimisticUpdateReminder((prev) =>
      prev.map((r) => r.id === id ? { ...r, dueAt: new Date(newDueAt).toISOString() } : r),
    );
    void refreshAfterReminderMutation(
      fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueAt: newDueAt }) })
    ).catch(() => { showShareToast("Could not reschedule. Try again."); void refreshReminders(); });
  }, [reminders, optimisticUpdateReminder, refreshAfterReminderMutation, showShareToast, refreshReminders]);

  /** Phase 2B: reschedule to tomorrow — keep same clock time. */
  const handleRescheduleTomorrow = useCallback((id: string) => {
    const reminder = reminders.find((r) => r.id === id);
    if (!reminder) return;
    const original = new Date(reminder.dueAt);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(original.getHours(), original.getMinutes(), 0, 0);
    const newDueAt = tomorrow.getTime();
    optimisticUpdateReminder((prev) =>
      prev.map((r) => r.id === id ? { ...r, dueAt: new Date(newDueAt).toISOString() } : r),
    );
    void refreshAfterReminderMutation(
      fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueAt: newDueAt }) })
    ).catch(() => { showShareToast("Could not reschedule. Try again."); void refreshReminders(); });
  }, [reminders, optimisticUpdateReminder, refreshAfterReminderMutation, showShareToast, refreshReminders]);

  /** Phase 2C: archive all missed reminders at once. */
  const handleArchiveAllMissed = useCallback(() => {
    const missedIds = grouped.missed.map((r) => r.id);
    if (!missedIds.length) return;
    optimisticUpdateReminder((prev) =>
      prev.map((r) => missedIds.includes(r.id) ? { ...r, status: "archived" as const } : r),
    );
    void Promise.all(
      missedIds.map((id) =>
        fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "archived" }) }),
      ),
    ).then(() => refreshReminders()).catch(() => {
      showShareToast("Some reminders could not be archived. Try again.");
      void refreshReminders();
    });
  }, [grouped.missed, optimisticUpdateReminder, refreshReminders, showShareToast]);

  /** Phase 2C: distribute all missed reminders across the next 7 days. */
  const handleRescheduleAllMissed = useCallback(() => {
    const missed = [...grouped.missed].sort((a, b) => (b.priority ?? 3) - (a.priority ?? 3));
    if (!missed.length) return;
    const now = Date.now();
    const updates = missed.map((r, idx) => {
      const original = new Date(r.dueAt);
      const daysAhead = Math.floor((idx * 7) / missed.length) + 1; // spread across week
      const target = new Date(now);
      target.setDate(target.getDate() + daysAhead);
      target.setHours(original.getHours(), original.getMinutes(), 0, 0);
      // If that time is in the past (same day), bump to 1 hour from now
      const newDueAt = target.getTime() > now ? target.getTime() : now + 60 * 60 * 1000;
      return { id: r.id, dueAt: newDueAt };
    });
    optimisticUpdateReminder((prev) =>
      prev.map((r) => {
        const upd = updates.find((u) => u.id === r.id);
        return upd ? { ...r, dueAt: new Date(upd.dueAt).toISOString() } : r;
      }),
    );
    void Promise.all(
      updates.map(({ id, dueAt }) =>
        fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueAt }) }),
      ),
    ).then(() => refreshReminders()).catch(() => {
      showShareToast("Some reminders could not be rescheduled. Try again.");
      void refreshReminders();
    });
  }, [grouped.missed, optimisticUpdateReminder, refreshReminders, showShareToast]);

  /** Phase 2D: restore a done reminder back to pending. */
  const handleRestore = useCallback((id: string) => {
    optimisticUpdateReminder((prev) =>
      prev.map((r) => r.id === id ? { ...r, status: "pending" as const } : r),
    );
    void refreshAfterReminderMutation(
      fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "pending" }) })
    ).catch(() => { showShareToast("Could not restore reminder. Try again."); void refreshReminders(); });
  }, [optimisticUpdateReminder, refreshAfterReminderMutation, showShareToast, refreshReminders]);

  return (
    <>
      <section className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-[#fafaf9]">
        <div className="flex min-h-0 w-full flex-1">
          {/* See ./desktop-panel.tsx */}
          <DesktopPanel
            reminders={reminders}
            grouped={grouped}
            snapshot={snapshot}
            shareInbox={shareInbox}
            activeTab={reminderListTabDesktop}
            onTabChange={setReminderListTabDesktop}
            searchQuery={reminderSearchQuery}
            onSearchChange={setReminderSearchQuery}
            isHistoryLoaded={isHistoryLoaded}
            briefingStreaming={briefingStreaming}
            isLoading={isLoading}
            onNewReminder={() => showCreateOverlay({})}
            onAllTasks={openAllTasksFromSnapshot}
            onRunBriefing={runBriefingStream}
            onMarkDone={(id) => {
              const reminder = reminders.find((r) => r.id === id);
              if (reminder) { triggerUndoAction("done", reminder); return; }
              void refreshAfterReminderMutation(
                fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) })
              );
            }}
            onEdit={openEditModal}
            onShare={showShareOverlay}
            onAcceptShare={(batchKey) => void joinShareBatch(batchKey)}
            onDenyShare={(batchKey) => void dismissShareBatch(batchKey)}
          />

          {/* MOBILE + DESKTOP CHAT — right panel on desktop, full screen on mobile */}
          {/* See ./chat-panel.tsx */}
          <ChatPanel
            mounted={mounted}
            dueNotifBannerDismissed={dueNotifBannerDismissed}
            onRequestNotifPermission={requestDueNotificationPermission}
            onDismissNotifBanner={dismissDueNotifBanner}
            firstName={user?.firstName}
            snapshot={snapshot}
            laterCount={grouped.upcoming.length}
            onOpenReminderTab={(tab) => showReminderListOverlay(true, tab)}
            onNextTwoHours={openNextTwoHoursFromSnapshot}
            onAllReminders={() => showReminderListOverlay()}
            onAllTasks={openAllTasksFromSnapshot}
            onOpenMore={() => showSnapshotOverlay()}
            onRunBriefing={runBriefingStream}
            isHistoryLoaded={isHistoryLoaded}
            briefingStreaming={briefingStreaming}
            isLoading={isLoading}
            chatScrollRef={chatScrollRef}
            onChatScroll={onChatScroll}
            messages={messages}
            onSetReplyTarget={setReplyTarget}
            onSetEditingMessageId={setEditingMessageId}
            onSetInput={setInput}
            reminders={reminders}
            onDueReminderAction={handleDueReminderAction}
            loadingTextIndex={loadingTextIndex}
            showSuggestedQuestions={showSuggestedQuestions}
            followUpQuestions={followUpQuestions}
            tasks={tasks}
            onSetFollowUpQuestions={setFollowUpQuestions}
            onChatSubmit={handleChatSubmit}
            pendingCreateDraft={pendingCreateDraft}
            quickSubmitTextRef={quickSubmitTextRef}
            editingMessageId={editingMessageId}
            replyTarget={replyTarget}
            onShowCreateOverlay={() => showCreateOverlay()}
            composerTextareaRef={composerTextareaRef}
            input={input}
            onCardAction={applyAction}
          />
        </div>{/* end 3-panel container */}
      </section>

      {/* Mobile bottom nav — see ./bottom-nav.tsx */}
      <BottomNav
        isListOpen={isListOpen}
        isTasksOpen={isTasksOpen}
        missedCount={snapshot.missed}
        onOpenReminders={(tab) => showReminderListOverlay(true, tab)}
        onOpenTasks={openAllTasksFromSnapshot}
        onOpenMore={() => showSnapshotOverlay()}
      />

      {isSnapshotOpen && (
        <SnapshotOverlay
          snapshot={snapshot}
          laterCount={grouped.upcoming.length}
          onClose={closeSnapshotOverlay}
          onOpenReminderTab={(tab) => {
            showReminderListOverlay(true, tab);
          }}
          onNextTwoHours={openNextTwoHoursFromSnapshot}
          onCreateReminder={() => showCreateOverlay()}
          onAllReminders={() => showReminderListOverlay()}
          onCreateTask={() => showTasksOverlay("create")}
          onAllTasks={openAllTasksFromSnapshot}
          onRunBriefing={() => {
            closeSnapshotOverlay();
            runBriefingStream();
          }}
          onImport={() => showImportOverlay()}
          onExport={() => {
            closeSnapshotOverlay();
            handleExportChat();
          }}
          onBatch={() => showBatchOverlay()}
          isExportDisabled={isLoading || messages.length === 0}
          isBatchDisabled={isLoading}
          showSuggestedQuestions={showSuggestedQuestions}
          onToggleSuggestedQuestions={setShowSuggestedQuestions}
          dueNotifPrefs={dueNotifPrefs}
          onChangeDueNotifPrefs={(next) => {
            setDueNotifPrefs(next);
          }}
          onRequestNotifPermission={() => void requestDueNotificationPermission()}
          onClearChat={() => {
            closeSnapshotOverlay();
            void handleClearChat();
          }}
          isClearingChat={isClearingChat}
          isClearingChatDisabled={isClearingChat || isLoading}
          user={user}
          onSignOut={() => void signOut(() => router.push("/sign-in"))}
          isAdmin={canAccessAdmin(getRoleFromPublicMetadata(user?.publicMetadata))}
          onOpenAdmin={() => {
            closeSnapshotOverlay();
            router.push("/admin");
          }}
        />
      )}

      {isCreateOpen && (
        <CreateReminderOverlay
          editingReminder={editingReminder}
          initialLinkedTaskId={reminderInitialLinkedTaskId}
          reminders={reminders}
          tasks={tasks}
          onClose={() => {
            setEditingReminder(null);
            setReminderInitialLinkedTaskId("");
            closeCreateOverlay();
          }}
          onDeleteReminder={(id) => {
            setEditingReminder(null);
            closeCreateOverlay();
            const reminder = reminders.find((r) => r.id === id);
            if (reminder) { triggerUndoAction("delete", reminder); return; }
            setPendingReminderCardDelete({ id, title: "this reminder" });
          }}
          onSaveSuccess={playReminderSuccessAnimation}
          refreshReminders={refreshReminders}
          refreshTasks={refreshTasks}
          onShowToast={showShareToast}
        />
      )}

      {isListOpen && (
        <ReminderListOverlay
          initialTab={reminderListInitialTab}
          isLoading={!remindersLoaded}
          reminders={reminders}
          grouped={grouped}
          snapshot={snapshot}
          nextTwoHoursReminders={nextTwoHoursReminders}
          tasks={tasks}
          taskTitleById={taskTitleById}
          shareInbox={shareInbox}
          reminderLongPressTimerRef={reminderLongPressTimerRef}
          onClose={closeReminderListOverlay}
          onOpenCreate={() => showCreateOverlay()}
          onMarkDone={(id) => {
            const reminder = reminders.find((r) => r.id === id);
            if (reminder) { triggerUndoAction("done", reminder); return; }
            // Fallback
            optimisticUpdateReminder((prev) =>
              prev.map((r) => r.id === id ? { ...r, status: "done" as const } : r),
            );
            void refreshAfterReminderMutation(
              fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) })
            ).catch(() => {
              showShareToast("Could not update reminder. Try again.");
              void refreshReminders();
            });
          }}
          onDelete={(id) => {
            const reminder = reminders.find((r) => r.id === id);
            if (reminder) { triggerUndoAction("delete", reminder); return; }
            setPendingReminderCardDelete({ id, title: "this reminder" });
          }}
          onEdit={openEditModal}
          onShare={showShareOverlay}
          onSnooze={(id, dueAt) => {
            const newDueAt = new Date(dueAt).getTime() + 60 * 60 * 1000;
            optimisticUpdateReminder((prev) =>
              prev.map((r) => r.id === id ? { ...r, dueAt: new Date(newDueAt).toISOString() } : r),
            );
            void refreshAfterReminderMutation(
              fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueAt: newDueAt }) })
            ).catch(() => {
              showShareToast("Could not snooze reminder.");
              void refreshReminders();
            });
          }}
          onRescheduleToday={handleRescheduleToday}
          onRescheduleTomorrow={handleRescheduleTomorrow}
          onArchiveAllMissed={handleArchiveAllMissed}
          onRescheduleAllMissed={handleRescheduleAllMissed}
          onRestore={handleRestore}
          onAcceptShare={(batchKey) => void joinShareBatch(batchKey)}
          onDenyShare={(batchKey) => void dismissShareBatch(batchKey)}
          onShowToast={showShareToast}
        />
      )}

      {taskActionWarning ? (
        <TaskWarningModal
          warning={taskActionWarning}
          onConfirm={confirmTaskWarning}
          onDismiss={() => setTaskActionWarning(null)}
        />
      ) : null}

      {pendingReminderCardDelete ? (
        <DeleteReminderConfirm
          id={pendingReminderCardDelete.id}
          title={pendingReminderCardDelete.title}
          onConfirm={async (id) => {
            setPendingReminderCardDelete(null);
            await refreshAfterReminderMutation(
              fetch(`/api/reminders/${id}`, { method: "DELETE" }),
            );
          }}
          onDismiss={() => setPendingReminderCardDelete(null)}
        />
      ) : null}

      {isShareOpen && (
        <ShareOverlay
          shareReminderIds={shareReminderIds}
          reminders={reminders}
          directoryUsers={directoryUsers}
          directoryLoading={directoryLoading}
          directoryError={directoryError}
          selectedShareUserIds={selectedShareUserIds}
          shareSending={shareSending}
          onToggleUser={toggleShareUser}
          onSend={() => void sendShares()}
          onClose={closeShareOverlay}
          getDisplayName={directoryDisplayName}
        />
      )}

      <TaskListOverlay
        open={isTasksOpen && taskMode === "browse"}
        taskTab={taskTab}
        setTaskTab={setTaskTab}
        taskSearchQuery={taskSearchQuery}
        setTaskSearchQuery={setTaskSearchQuery}
        tasksGrouped={tasksGrouped}
        reminders={reminders}
        onClose={closeTasksOverlay}
        onViewReminders={openReminderListFromTasksPanel}
        onCreateTask={() => {
          setTaskMode("create");
          showTasksOverlay("create");
        }}
        onEditTask={openTaskEdit}
        onToggleStatus={requestTaskStatusToggle}
        onDeleteTask={requestTaskDelete}
        onCreateLinkedReminder={openLinkedReminderForTask}
        onReminderMarkDone={(reminder) =>
          handleTaskReminderAction(reminder, "done")
        }
        onReminderEdit={openEditModal}
        onReminderReschedule={openTaskReminderReschedule}
        onReminderDelete={(reminder) =>
          handleTaskReminderAction(reminder, "delete")
        }
      />

      <TaskFormOverlay
        open={isTasksOpen && taskMode === "create"}
        editingTaskId={editingTaskId}
        taskFormTitle={taskFormTitle}
        setTaskFormTitle={setTaskFormTitle}
        taskFormDue={taskFormDue}
        setTaskFormDue={setTaskFormDue}
        taskFormNotes={taskFormNotes}
        setTaskFormNotes={setTaskFormNotes}
        taskFormDomain={taskFormDomain}
        setTaskFormDomain={setTaskFormDomain}
        taskStars={taskStars}
        setTaskStars={setTaskStars}
        taskFormError={taskFormError}
        setTaskFormError={setTaskFormError}
        taskDueUserEdited={taskDueUserEdited}
        setTaskDueUserEdited={setTaskDueUserEdited}
        onSubmit={handleTaskSave}
        onCancelEdit={resetTaskForm}
        onClose={closeTasksOverlay}
        onViewReminders={openReminderListFromTasksPanel}
        onCreateLinkedReminder={() => void startReminderForCurrentTask()}
      />

      {isImportOpen && (
        <ImportOverlay
          refreshReminders={refreshReminders}
          refreshTasks={refreshTasks}
          onClose={closeImportOverlay}
        />
      )}

      {/* Phase 2A: Undo toast — appears for 5 seconds after Done or Delete */}
      {pendingUndoAction ? (
        <div
          className="pointer-events-auto fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[60] -translate-x-1/2 flex items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 shadow-lg dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          role="status"
          aria-live="polite"
        >
          <span>
            {pendingUndoAction.type === "done" ? "Marked done" : "Deleted"}{" "}
            &ldquo;{pendingUndoAction.reminder.title.length > 30 ? `${pendingUndoAction.reminder.title.slice(0, 30)}…` : pendingUndoAction.reminder.title}&rdquo;
          </span>
          <button
            onClick={cancelUndoAction}
            className="ml-1 font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            aria-label="Undo"
          >
            Undo
          </button>
        </div>
      ) : null}

      {shareToast ? (
        <div
          className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[60] -translate-x-1/2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 shadow-lg dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          role="status"
          aria-live="polite"
        >
          {shareToast}
        </div>
      ) : null}

      {rescheduleReminder ? (
        <RescheduleReminderModal
          rescheduleReminder={rescheduleReminder}
          setRescheduleReminder={setRescheduleReminder}
          onSave={() => void commitRescheduleReminder()}
        />
      ) : null}

      {showReminderSuccess ? (
        <div className="pointer-events-none fixed inset-0 z-[65] flex flex-col items-center justify-center gap-3">
          <div className="relative">
            <span className="absolute inset-0 rounded-full bg-emerald-400/30 animate-ping" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 shadow-2xl shadow-emerald-500/40 ring-4 ring-emerald-200">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-10 w-10">
                <path d="m5 12 4 4 10-10" />
              </svg>
            </div>
          </div>
          <div className="text-center">
            <p className="text-[20px] font-extrabold text-slate-900">Reminder saved!</p>
            {reminderSuccessInfo && (
              <p className="mt-0.5 text-[13px] text-slate-500">
                {reminderSuccessInfo.title} · {reminderSuccessInfo.time}
              </p>
            )}
          </div>
        </div>
      ) : null}

      {winCopy ? (
        <div className="pointer-events-none fixed inset-0 z-[66] flex flex-col items-center justify-center px-6">
          <div className="flex max-w-xs flex-col items-center gap-3 rounded-3xl bg-white/95 px-7 py-6 text-center shadow-2xl ring-1 ring-emerald-200 backdrop-blur dark:bg-slate-900/95 dark:ring-emerald-500/30">
            <div className="relative">
              <span className="absolute inset-0 rounded-full bg-emerald-400/30 animate-ping" />
              <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-lg shadow-emerald-500/40">
                <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8"><path d="m5 12 4 4 10-10" /></svg>
              </div>
            </div>
            <p className="text-[19px] font-extrabold leading-tight text-slate-900 dark:text-slate-50">{winCopy.line}</p>
            {winCopy.sub ? (
              <p className="text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">{winCopy.sub}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <WalkthroughOverlay
        open={walkthroughOpen}
        step={currentWalkthroughStep}
        stepIndex={walkthroughStepIndex}
        stepCount={walkthroughStepCount}
        onNext={advanceWalkthrough}
        onClose={closeWalkthrough}
      />

      {isBatchOpen && (
        <BatchOverlay
          onRun={runBatchQuestions}
          onClose={closeBatchOverlay}
        />
      )}
    </>
  );
}
