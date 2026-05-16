"use client";

/**
 * use-chat-side-effects.ts
 *
 * Groups several "downstream" chat UI effects that depend on messages/reminders
 * but don't own their own state:
 *  - Follow-up question suggestions
 *  - Opening summary insertion (once on load)
 *  - Missed-reminder deduplication guard (once on load)
 *  - Chat auto-scroll
 *  - Sound cue on new assistant message
 *
 * Extracted from dashboard-workspace.tsx to reduce line count.
 */

import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  buildFollowUpQuestions,
  type FollowUpQuestion,
  type ReminderItem,
  type TaskItemBrief,
} from "@repo/reminder";
import { playUiCue } from "../../lib/ui-sound";
import { buildOpeningSummaryMessage } from "./dashboard-utils";
import type { ChatMessage } from "./dashboard-types";
import type { TaskRow } from "./task-panels";

export interface UseChatSideEffectsParams {
  messages: ChatMessage[];
  reminders: ReminderItem[];
  tasks: TaskRow[];
  isHistoryLoaded: boolean;
  isLoading: boolean;
  briefingStreaming: boolean;
  remindersLoaded: boolean;
  tasksLoaded: boolean;
  firstName: string | null | undefined;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setFollowUpQuestions: Dispatch<SetStateAction<FollowUpQuestion[]>>;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  chatPinnedToBottomRef: MutableRefObject<boolean>;
  openingSummaryAppliedRef: MutableRefObject<boolean>;
  missedRemindersAppliedRef: MutableRefObject<boolean>;
}

export function useChatSideEffects({
  messages,
  reminders,
  tasks,
  isHistoryLoaded,
  isLoading,
  briefingStreaming,
  remindersLoaded,
  tasksLoaded,
  firstName,
  setMessages,
  setFollowUpQuestions,
  chatScrollRef,
  chatPinnedToBottomRef,
  openingSummaryAppliedRef,
  missedRemindersAppliedRef,
}: UseChatSideEffectsParams) {
  // ── Follow-up question suggestions ─────────────────────────────────────
  useEffect(() => {
    if (briefingStreaming) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content;
    const taskBrief: TaskItemBrief[] = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      status: t.status,
      priority: t.priority,
    }));
    setFollowUpQuestions(
      buildFollowUpQuestions({
        reminders,
        tasks: taskBrief,
        lastUserMessage: lastUser,
        firstName: firstName ?? undefined,
      }),
    );
  }, [messages, reminders, tasks, firstName, briefingStreaming, setFollowUpQuestions]);

  // ── Opening summary (once per session load) ─────────────────────────────
  useEffect(() => {
    if (!isHistoryLoaded || !remindersLoaded || !tasksLoaded) return;
    if (openingSummaryAppliedRef.current) return;
    const summary = buildOpeningSummaryMessage({
      reminders,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        status: task.status,
        priority: task.priority,
      })),
      firstName: firstName ?? undefined,
    });
    setMessages((prev) => [
      summary,
      ...prev.filter(
        (message) => message.id !== "starter" && message.meta?.kind !== "opening_summary",
      ),
    ]);
    openingSummaryAppliedRef.current = true;
  }, [
    isHistoryLoaded, remindersLoaded, tasksLoaded,
    reminders, tasks, firstName,
    setMessages, openingSummaryAppliedRef,
  ]);

  // ── Missed reminders deduplication guard ───────────────────────────────
  useEffect(() => {
    if (!isHistoryLoaded || !remindersLoaded || !tasksLoaded) return;
    if (missedRemindersAppliedRef.current) return;
    if (!openingSummaryAppliedRef.current) return;
    missedRemindersAppliedRef.current = true;
  }, [
    isHistoryLoaded, remindersLoaded, tasksLoaded,
    reminders, missedRemindersAppliedRef, openingSummaryAppliedRef,
  ]);

  // ── Chat auto-scroll ────────────────────────────────────────────────────
  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    if (!chatPinnedToBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages, isLoading, briefingStreaming, chatScrollRef, chatPinnedToBottomRef]);

  // ── Sound cue on new assistant message ─────────────────────────────────
  const cueInitRef = useRef(false);
  const lastCueMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isHistoryLoaded) return;
    const latest = [...messages].reverse().find((m) => m.role !== "user");
    if (!latest) return;
    if (!cueInitRef.current) {
      cueInitRef.current = true;
      lastCueMessageIdRef.current = latest.id;
      return;
    }
    if (lastCueMessageIdRef.current === latest.id) return;
    lastCueMessageIdRef.current = latest.id;
    void playUiCue(latest.meta?.kind === "briefing" ? "briefing" : "notification");
  }, [messages, isHistoryLoaded]);
}
