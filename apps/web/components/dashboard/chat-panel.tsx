"use client";

/**
 * ChatPanel
 *
 * The right-hand (desktop) / full-screen (mobile) dark chat panel.
 * Contains the notification permission banner, chat message list,
 * follow-up question chips, and the composer form.
 * Extracted from dashboard-workspace.tsx.
 */

import { useRef, useMemo, type FormEvent, type Dispatch, type SetStateAction, type RefObject } from "react";
import { useOnlineStatus } from "./use-online-status";
import {
  replaceFollowUpSlot,
  type FollowUpQuestion,
  type TaskItemBrief,
  type ReminderItem,
} from "@repo/reminder";
import { ChatBubbleShell } from "./chat-bubble-shell";
import { ChatPanelHeader } from "./chat-panel-header";
import { StructuredMessage } from "./structured-message";
import { ReminderChatCard } from "./reminder-chat-card";
import { DisambigPickerCard } from "./disambig-picker-card";
import { PriorityPickerCard } from "./priority-picker-card";
import { briefingSectionLabel, chatReplyLabel, loadingTexts } from "./dashboard-utils";
import type { ChatMessage, AgentAction, PendingCreateDraft, PendingTimeSuggestion, ReminderListTab } from "./dashboard-types";
import type { SnapshotCounts } from "./reminder-list-overlay";
import type { TaskRow } from "./task-panels";

export interface ChatPanelProps {
  mounted: boolean;
  dueNotifBannerDismissed: boolean;
  onRequestNotifPermission: () => Promise<void>;
  onDismissNotifBanner: () => void;
  firstName?: string | null;
  snapshot: SnapshotCounts;
  laterCount: number;
  onOpenReminderTab: (tab: ReminderListTab) => void;
  onNextTwoHours: () => void;
  onAllReminders: () => void;
  onAllTasks: () => void;
  onOpenMore: () => void;
  onRunBriefing: () => void;
  isHistoryLoaded: boolean;
  briefingStreaming: boolean;
  isLoading: boolean;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  onChatScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  messages: ChatMessage[];
  onSetReplyTarget: (msg: ChatMessage | null) => void;
  onSetEditingMessageId: (id: string | null) => void;
  onSetInput: (val: string) => void;
  reminders: ReminderItem[];
  onDueReminderAction: (
    messageId: string,
    reminderId: string,
    action: "done" | "snooze" | "reschedule" | "delete",
  ) => Promise<void>;
  loadingTextIndex: number;
  showSuggestedQuestions: boolean;
  followUpQuestions: FollowUpQuestion[];
  tasks: TaskRow[];
  onSetFollowUpQuestions: Dispatch<SetStateAction<FollowUpQuestion[]>>;
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pendingCreateDraft: PendingCreateDraft | null;
  pendingTimeSuggestion: PendingTimeSuggestion | null;
  quickSubmitTextRef: RefObject<string | null>;
  editingMessageId: string | null;
  replyTarget: ChatMessage | null;
  onShowCreateOverlay: () => void;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  /** Dispatch an AgentAction from a reminder chat card (threads through applyAction). */
  onCardAction: (action: AgentAction) => void;
}

export function ChatPanel({
  mounted,
  dueNotifBannerDismissed,
  onRequestNotifPermission,
  onDismissNotifBanner,
  firstName,
  snapshot,
  laterCount,
  onOpenReminderTab,
  onNextTwoHours,
  onAllReminders,
  onAllTasks,
  onOpenMore,
  onRunBriefing,
  isHistoryLoaded,
  briefingStreaming,
  isLoading,
  chatScrollRef,
  onChatScroll,
  messages,
  onSetReplyTarget,
  onSetEditingMessageId,
  onSetInput,
  reminders,
  onDueReminderAction,
  loadingTextIndex,
  showSuggestedQuestions,
  followUpQuestions,
  tasks,
  onSetFollowUpQuestions,
  onChatSubmit,
  pendingCreateDraft,
  pendingTimeSuggestion,
  quickSubmitTextRef,
  editingMessageId,
  replyTarget,
  onShowCreateOverlay,
  composerTextareaRef,
  input,
  onCardAction,
}: ChatPanelProps) {
  const chatFormRef = useRef<HTMLFormElement>(null);
  const isOnline = useOnlineStatus();

  // Derived
  const briefingComposerLocked = briefingStreaming && !editingMessageId;

  const taskLinkQuickReplies = useMemo(
    () =>
      pendingCreateDraft?.step === "task"
        ? tasks.filter((t) => t.status === "pending").slice(0, 8)
        : [],
    [pendingCreateDraft?.step, tasks],
  );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col lg:w-[320px] lg:flex-none lg:border-l lg:border-slate-200" style={{ background: "#1a1625" }}>
    <div className="flex min-h-0 flex-1 flex-col gap-0">
      {mounted &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default" &&
      !dueNotifBannerDismissed ? (
        <div className="flex flex-col gap-2 rounded-none border-b border-violet-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm sm:rounded-[24px] sm:border lg:hidden">
          <p className="leading-snug text-slate-600">
            Allow notifications to get an instant alert when a reminder is
            due, then act from the alert with Done, Snooze, or Delete.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void onRequestNotifPermission()}
              className="rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
            >
              Allow alerts
            </button>
            <button
              type="button"
              onClick={onDismissNotifBanner}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Offline banner — shown whenever browser loses connectivity ── */}
      {!isOnline && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4 shrink-0 text-amber-500">
            <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.54 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
          </svg>
          You're offline — your last known reminders are shown. New actions will sync when reconnected.
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ background: "#1a1625" }}>
        {/* ── Chat panel header: mobile pills · tablet toolbar · desktop urgency strip ── */}
        {/* See ./chat-panel-header.tsx */}
        <ChatPanelHeader
          firstName={firstName}
          snapshot={snapshot}
          laterCount={laterCount}
          onOpenReminderTab={onOpenReminderTab}
          onNextTwoHours={onNextTwoHours}
          onAllReminders={onAllReminders}
          onAllTasks={onAllTasks}
          onOpenMore={onOpenMore}
          onRunBriefing={() => onRunBriefing()}
          isBriefingDisabled={!isHistoryLoaded || briefingStreaming || isLoading}
        />
        <div
          ref={chatScrollRef}
          onScroll={onChatScroll}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-[#1a1625] px-4 py-5 scrollbar-none sm:px-6 sm:py-6"
        >
          <div className="mx-auto grid min-w-0 max-w-4xl gap-4">
            {messages.map((message) => {
              const startReplyTo = () => {
                onSetReplyTarget(message);
                onSetEditingMessageId(null);
              };
              const startEditUser = () => {
                if (message.role !== "user") return;
                onSetEditingMessageId(message.id);
                onSetInput(message.content);
                onSetReplyTarget(null);
              };

              // ── Disambiguation picker — tappable candidate list ───────────────
              if (message.meta?.kind === "disambig_picker" && message.meta.disambigCandidateIds?.length) {
                return (
                  <div key={message.id}>
                    <DisambigPickerCard
                      meta={message.meta}
                      reminders={reminders}
                      onAction={onCardAction}
                    />
                  </div>
                );
              }

              // ── Priority picker — Critical / Medium / Chill before creation ────
              if (message.meta?.kind === "priority_picker" && message.meta.priorityPickerPayload) {
                return (
                  <div key={message.id}>
                    <PriorityPickerCard meta={message.meta} onAction={onCardAction} />
                  </div>
                );
              }

              // ── Reminder card messages — rendered as standalone cards ─────────
              if (message.meta?.kind === "reminder_card" && message.meta.reminderIds?.length) {
                const cardIds = message.meta.reminderIds;
                const total = message.meta.totalListedCount ?? cardIds.length;
                const extra = total - cardIds.length;
                // Operation previews carry a mode + prefill so the card opens
                // ready to edit/reschedule; list cards leave these undefined.
                const cardMode = message.meta.cardMode;
                const cardPrefill = message.meta.cardPrefill;
                return (
                  <div key={message.id} className="flex flex-col gap-2">
                    {cardIds.map((rid) => (
                      <ReminderChatCard
                        key={rid}
                        reminderId={rid}
                        reminders={reminders}
                        tasks={tasks}
                        onAction={onCardAction}
                        initialMode={cardMode}
                        prefill={cardPrefill}
                      />
                    ))}
                    {extra > 0 && (
                      <button
                        type="button"
                        onClick={onAllReminders}
                        className="self-start rounded-full border border-violet-500/30 bg-violet-900/20 px-3 py-1.5 text-[11px] font-semibold text-violet-300 transition hover:bg-violet-900/40"
                      >
                        +{extra} more reminder{extra !== 1 ? "s" : ""}
                      </button>
                    )}
                  </div>
                );
              }

              if (message.role === "system") {
                return (
                  <ChatBubbleShell
                    key={message.id}
                    onReply={startReplyTo}
                    showEdit={false}
                    actionAlign="center"
                    showActionsAlways
                    desktopHoverMenu
                  >
                    <div className="mx-auto min-w-0 max-w-[42rem] rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-center text-xs text-amber-900 shadow-sm">
                      <StructuredMessage content={message.content} />
                      <p className="mt-1 text-[10px] text-amber-700/80">
                        {new Date(message.createdAt).toLocaleTimeString(
                          [],
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </p>
                    </div>
                  </ChatBubbleShell>
                );
              }
              const dueMeta =
                message.meta?.kind === "due_reminder"
                  ? message.meta
                  : null;
              const dueReminder = dueMeta?.reminderId
                ? reminders.find((r) => r.id === dueMeta.reminderId)
                : null;
              const dueReminderResolved =
                !!dueMeta?.reminderId &&
                (!dueReminder ||
                  dueReminder.status === "done" ||
                  dueReminder.status === "archived");
              const replyQuote = message.meta?.replyTo;
              const showUserEdit =
                message.role === "user" && !dueMeta?.reminderId;
              const bubbleClass =
                message.role === "user"
                  ? "relative ml-auto min-w-0 max-w-[42rem] overflow-hidden rounded-[28px] rounded-br-[12px] bg-[linear-gradient(135deg,#7c3aed_0%,#5b7bff_100%)] px-4 py-3 text-sm text-white shadow-[0_24px_45px_-28px_rgba(91,123,255,0.9)]"
                  : "min-w-0 max-w-[42rem] overflow-hidden rounded-[28px] rounded-bl-[12px] border border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.13)] px-4 py-3 text-sm text-[rgba(255,255,255,0.92)] shadow-none";

              const inner = (
                <div
                  className={bubbleClass}
                  data-testid="chat-message"
                  data-message-role={message.role}
                >
                  {replyQuote ? (
                    <div
                      className={`mb-2 rounded-2xl border-l-4 border-amber-400 pl-3 ${
                        message.role === "user"
                          ? "bg-white/12"
                          : "bg-white/10"
                      }`}
                    >
                      <p
                        className={`pt-2 text-[10px] font-semibold ${
                          message.role === "user"
                            ? "text-amber-100"
                            : "text-amber-300"
                        }`}
                      >
                        {chatReplyLabel(replyQuote.role)}
                      </p>
                      <p
                        className={`line-clamp-5 whitespace-pre-wrap pb-2 text-[11px] leading-snug ${
                          message.role === "user"
                            ? "text-violet-50/95"
                            : "text-slate-300"
                        }`}
                      >
                        {replyQuote.content}
                      </p>
                    </div>
                  ) : null}
                  {dueMeta?.reminderId ? (
                    <>
                      <p className="font-semibold text-[rgba(255,255,255,0.9)]">
                        Reminder due
                      </p>
                      <p className="mt-1 min-w-0 max-w-full whitespace-pre-wrap break-words leading-relaxed text-[rgba(255,255,255,0.88)] [overflow-wrap:anywhere]">
                        {dueMeta.title}
                      </p>
                      <p className="mt-1 text-xs text-[rgba(255,255,255,0.55)]">
                        {new Date(
                          dueMeta.dueAt ?? Date.now(),
                        ).toLocaleString()}
                      </p>
                      {dueMeta.notes ? (
                        <p className="mt-1 text-xs text-[rgba(255,255,255,0.45)]">
                          {dueMeta.notes}
                        </p>
                      ) : null}
                      {dueReminderResolved ? (
                        <p className="mt-3 text-xs font-medium text-[rgba(255,255,255,0.55)]">
                          {dueReminder?.status === "done"
                            ? "Already marked done."
                            : "This reminder was already updated from another action."}
                        </p>
                      ) : (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              void onDueReminderAction(
                                message.id,
                                dueMeta.reminderId!,
                                "done",
                              )
                            }
                            data-testid="due-reminder-done-button"
                            className="rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500"
                          >
                            Done
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void onDueReminderAction(
                                message.id,
                                dueMeta.reminderId!,
                                "snooze",
                              )
                            }
                            data-testid="due-reminder-snooze-button"
                            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-800 hover:bg-slate-50"
                          >
                            Snooze 1h
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void onDueReminderAction(
                                message.id,
                                dueMeta.reminderId!,
                                "reschedule",
                              )
                            }
                            data-testid="due-reminder-reschedule-button"
                            className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-semibold text-violet-900 hover:bg-violet-100"
                          >
                            Set new time
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void onDueReminderAction(
                                message.id,
                                dueMeta.reminderId!,
                                "delete",
                              )
                            }
                            data-testid="due-reminder-delete-button"
                            className="rounded-full bg-rose-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-500"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Sender label */}
                      <p
                        className={`mb-1 text-[10px] font-bold uppercase tracking-[0.18em] ${
                          message.role === "user"
                            ? "text-violet-100/70"
                            : "text-[rgba(255,255,255,0.38)]"
                        }`}
                      >
                        {message.role === "user" ? "You" : "RemindOS"}
                      </p>
                      {message.meta?.kind === "briefing" ? (
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                          {briefingSectionLabel(
                            message.meta.briefingSection,
                          )}
                        </p>
                      ) : null}
                      <StructuredMessage
                        content={message.content}
                        className="min-w-0 max-w-full leading-relaxed [overflow-wrap:anywhere]"
                      />
                    </>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p
                      className={`flex min-w-0 flex-wrap items-center gap-2 text-[10px] ${
                        message.role === "user"
                          ? "text-violet-100"
                          : "text-[rgba(255,255,255,0.3)]"
                      }`}
                    >
                      <span>
                        {new Date(message.createdAt).toLocaleTimeString(
                          [],
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </span>
                      {message.meta?.editedAt &&
                      message.role === "user" ? (
                        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-50">
                          Edited
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>
              );

              return (
                <ChatBubbleShell
                  key={message.id}
                  onReply={startReplyTo}
                  onEdit={
                    message.role === "user" && showUserEdit
                      ? startEditUser
                      : undefined
                  }
                  showEdit={message.role === "user" && showUserEdit}
                  actionAlign={message.role === "user" ? "end" : "start"}
                  showActionsAlways={message.role === "user"}
                  desktopHoverMenu
                  onLongPressEdit={
                    message.role === "user" && showUserEdit
                      ? startEditUser
                      : undefined
                  }
                >
                  {inner}
                </ChatBubbleShell>
              );
            })}
            {isLoading ? (
              <div className="min-w-0 max-w-[42rem] rounded-[28px] rounded-bl-[12px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.08)] px-4 py-3 text-sm text-[rgba(255,255,255,0.7)]">
                <p className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {loadingTexts[loadingTextIndex]}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {showSuggestedQuestions && followUpQuestions.length > 0 ? (
          <div className="shrink-0 border-t border-[rgba(255,255,255,0.06)] px-4 pb-2 pt-2 sm:px-4">
            <div className="mx-auto max-w-4xl">
              {/* On desktop: single scrollable row so suggestions never push messages up.
                  On mobile: wrap onto multiple rows as before. */}
              <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-nowrap sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden">
                {followUpQuestions.map((q, i) => (
                  <button
                    key={`${q.kind}-${i}-${q.text.slice(0, 24)}`}
                    type="button"
                    disabled={briefingStreaming}
                    onClick={() => {
                      const lastUser = [...messages]
                        .reverse()
                        .find((m) => m.role === "user")?.content;
                      const taskBrief: TaskItemBrief[] = tasks.map(
                        (t) => ({
                          id: t.id,
                          title: t.title,
                          dueAt: t.dueAt,
                          status: t.status,
                          priority: t.priority,
                        }),
                      );
                      onSetInput(q.text);
                      onSetFollowUpQuestions((prev) =>
                        replaceFollowUpSlot(prev, i as 0 | 1 | 2, {
                          reminders,
                          tasks: taskBrief,
                          lastUserMessage: lastUser,
                          firstName: firstName ?? undefined,
                        }),
                      );
                    }}
                    className={`min-h-[2.75rem] shrink-0 rounded-full border px-4 py-2 text-left text-xs font-medium leading-snug transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:max-w-[18rem] sm:truncate sm:px-3 sm:py-1.5 ${
                      q.kind === "action"
                        ? "border-emerald-500/30 bg-emerald-600/15 text-emerald-300 hover:bg-emerald-600/25"
                        : "border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.06)] text-[rgba(255,255,255,0.7)] hover:bg-[rgba(255,255,255,0.1)]"
                    }`}
                    title={q.text}
                  >
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <form
          ref={chatFormRef}
          onSubmit={onChatSubmit}
          data-testid="chat-form"
          className={`shrink-0 border-t border-[rgba(255,255,255,0.06)] px-3 pb-[max(5rem,calc(env(safe-area-inset-bottom)+4.5rem))] pt-3 sm:px-4 sm:pb-4 lg:pb-4 ${
            briefingComposerLocked ? "opacity-90" : ""
          }`}
          style={{ background: "#1a1625" }}
        >
          <div className="mx-auto max-w-4xl">
            {pendingTimeSuggestion ? (
              <div className="mb-3 rounded-2xl border border-blue-300 bg-blue-50 px-3 py-3 dark:border-blue-500/40 dark:bg-blue-500/10">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
                  Create this reminder?
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  “{pendingTimeSuggestion.title}”
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {new Date(pendingTimeSuggestion.suggestedDueAt).toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {pendingTimeSuggestion.recurrence && pendingTimeSuggestion.recurrence !== "none"
                    ? ` · repeats ${pendingTimeSuggestion.recurrence}`
                    : ""}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="confirm-create-reminder"
                    disabled={isLoading || (briefingStreaming && !editingMessageId)}
                    onClick={() => {
                      quickSubmitTextRef.current = "yes";
                      requestAnimationFrame(() => {
                        chatFormRef.current?.requestSubmit();
                      });
                    }}
                    className="min-h-[2.5rem] rounded-full bg-blue-600 px-5 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    ✓ Yes, create
                  </button>
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() => {
                      onSetInput("");
                      composerTextareaRef.current?.focus();
                    }}
                    className="min-h-[2.5rem] rounded-full border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    Pick another time
                  </button>
                </div>
              </div>
            ) : null}
            {pendingCreateDraft?.step === "task" ? (
              <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/60">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  Select task
                </p>
                <div className="flex gap-2 overflow-x-auto scroll-smooth pb-1">
                  <button
                    type="button"
                    disabled={isLoading || (briefingStreaming && !editingMessageId)}
                    onClick={() => {
                      quickSubmitTextRef.current = "no";
                      requestAnimationFrame(() => {
                        chatFormRef.current?.requestSubmit();
                      });
                    }}
                    className="shrink-0 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    Standalone
                  </button>
                  {taskLinkQuickReplies.map((task) => (
                    <button
                      key={`task-link-chip-${task.id}`}
                      type="button"
                      disabled={isLoading || (briefingStreaming && !editingMessageId)}
                      onClick={() => {
                        quickSubmitTextRef.current = task.title;
                        requestAnimationFrame(() => {
                          chatFormRef.current?.requestSubmit();
                        });
                      }}
                      className="shrink-0 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-medium text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-700 dark:bg-slate-950 dark:text-violet-200 dark:hover:bg-violet-900/30"
                    >
                      {task.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {editingMessageId ? (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-[22px] border border-violet-200 bg-violet-50 px-4 py-3 text-xs text-violet-700">
                <span className="font-medium">Editing your message</span>
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-violet-200 px-3 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100"
                  onClick={() => {
                    onSetEditingMessageId(null);
                    onSetInput("");
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : null}
            {replyTarget && !editingMessageId ? (
              <div className="mb-3 flex items-start gap-2 rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="min-w-0 flex-1 border-l-4 border-amber-400 pl-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-700">
                    {chatReplyLabel(replyTarget.role)}
                  </p>
                  <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-snug text-slate-700">
                    {replyTarget.content}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-amber-200 px-2.5 py-0.5 text-lg leading-none text-amber-700 hover:bg-amber-100"
                  aria-label="Cancel reply"
                  onClick={() => onSetReplyTarget(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
            {/* ── Suggestion chips (mobile only) ── */}
            <div className="mb-2 flex gap-2 overflow-x-auto scrollbar-none sm:hidden">
              {[
                { label: "What's overdue?",  onClick: () => { onSetInput("What's overdue?"); chatFormRef.current?.requestSubmit(); } },
                { label: "Create reminder",  onClick: () => onShowCreateOverlay() },
                { label: "Run briefing",     onClick: () => onRunBriefing() },
                { label: "What's today?",    onClick: () => { onSetInput("What's due today?"); chatFormRef.current?.requestSubmit(); } },
              ].map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={chip.onClick}
                  disabled={isLoading || (briefingStreaming && !editingMessageId)}
                  className="shrink-0 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 py-1.5 text-[11px] font-medium text-[rgba(255,255,255,0.65)] transition hover:bg-[rgba(255,255,255,0.12)] disabled:opacity-40"
                >
                  {chip.label}
                </button>
              ))}
            </div>
            <div className="flex w-full min-w-0 items-end gap-2 rounded-[28px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] py-2 pl-2 pr-2">
              {/* + Create reminder — visible on mobile, hidden on sm+ */}
              <button
                type="button"
                onClick={() => onShowCreateOverlay()}
                disabled={briefingComposerLocked}
                data-walkthrough="create-reminder-trigger"
                data-testid="chat-mobile-create-reminder"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-xl font-semibold text-white shadow-sm transition hover:bg-violet-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:hidden"
                aria-label="Create reminder"
                title="Create reminder"
              >
                +
              </button>
              <div className="relative min-h-[2.4rem] min-w-0 flex-1">
                <textarea
                  ref={composerTextareaRef}
                  rows={1}
                  value={input}
                  onChange={(event) => onSetInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    briefingComposerLocked && !editingMessageId
                      ? "Briefing in progress…"
                      : "Ask or add a reminder…"
                  }
                  readOnly={briefingComposerLocked && !editingMessageId}
                  aria-busy={briefingStreaming}
                  aria-label={
                    briefingStreaming
                      ? "Message (wait for briefing to finish)"
                      : "Message"
                  }
                  data-testid="chat-input"
                  className={`scrollbar-none relative z-10 min-h-10 w-full resize-none overflow-y-hidden rounded-2xl bg-transparent px-2 py-1.5 text-sm leading-6 text-[rgba(255,255,255,0.88)] [overflow-wrap:anywhere] outline-none placeholder:text-[rgba(255,255,255,0.35)] ${
                    briefingComposerLocked && !editingMessageId
                      ? "cursor-wait caret-transparent"
                      : ""
                  }`}
                />
              </div>
              <button
                type="submit"
                disabled={
                  !input.trim() ||
                  isLoading ||
                  (briefingStreaming && !editingMessageId)
                }
                data-testid="chat-send-button"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-base font-semibold text-white shadow-md transition hover:bg-violet-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Send message"
              >
                {isLoading || (briefingStreaming && !editingMessageId) ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>{/* end inner wrap */}
    </div>
  );
}
