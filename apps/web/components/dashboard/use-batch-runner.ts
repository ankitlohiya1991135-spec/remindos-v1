"use client";

/**
 * use-batch-runner.ts
 *
 * Handles batch question processing (BatchOverlay).
 * Extracted from dashboard-workspace.tsx to reduce line count.
 */

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { tryGroundedReminderAnswer, type ReminderItem } from "@repo/reminder";
import { clientTimeZonePayload } from "./dashboard-utils";
import type { AgentAction, AgentResponse, ChatMessage } from "./dashboard-types";
import type { TaskRow } from "./task-panels";

// ─── Module-level helpers (no state deps — stable across renders) ─────────────

function parseBatchQuestions(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as { questions?: unknown; items?: unknown; prompts?: unknown };
  const candidate = obj.questions ?? obj.items ?? obj.prompts;
  if (!Array.isArray(candidate)) return [];
  return candidate
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

const BATCH_MAX_QUESTIONS_PER_MINUTE = 30;
const BATCH_MIN_INTERVAL_MS = Math.ceil(60_000 / BATCH_MAX_QUESTIONS_PER_MINUTE);

const waitFor = (durationMs: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs);
  });

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseBatchRunnerParams {
  applyAction: (action: AgentAction) => void;
  remindersRef: MutableRefObject<ReminderItem[]>;
  tasksRef: MutableRefObject<TaskRow[]>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

export function useBatchRunner({
  applyAction,
  remindersRef,
  tasksRef,
  setMessages,
}: UseBatchRunnerParams) {
  const runBatchQuestions = useCallback(
    async (
      rawJson: string,
      setStatus: (s: string | null) => void,
      _setRunning: (b: boolean) => void,
      clearJson: () => void,
    ) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson) as unknown;
      } catch {
        setStatus("Invalid JSON. Please paste a valid JSON object or array.");
        return;
      }

      const questions = parseBatchQuestions(parsed);
      if (questions.length === 0) {
        setStatus("No valid questions found. Use an array or { questions: [...] }.");
        return;
      }

      let processed = 0;
      let nextAllowedSendAt = Date.now();
      for (const [index, question] of questions.entries()) {
        const now = Date.now();
        if (now < nextAllowedSendAt) {
          const waitMs = nextAllowedSendAt - now;
          setStatus(`Waiting ${Math.ceil(waitMs / 1000)}s before sending ${index + 1}/${questions.length}...`);
          await waitFor(waitMs);
        }

        const sentAt = Date.now();
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "user", content: question, createdAt: new Date().toISOString() },
        ]);
        setStatus(`Processing ${processed + 1}/${questions.length} (one at a time)...`);

        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: question,
              reminders: remindersRef.current,
              tasks: tasksRef.current.map((t) => ({
                id: t.id, title: t.title, notes: t.notes,
                dueAt: t.dueAt, status: t.status, priority: t.priority, domain: t.domain,
              })),
              ...clientTimeZonePayload(),
            }),
          });
          const data = (await response.json()) as AgentResponse;
          applyAction(data.action);
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", content: data.reply || "Done.", createdAt: new Date().toISOString() },
          ]);
        } catch {
          const grounded = tryGroundedReminderAnswer(question, remindersRef.current, new Date(), clientTimeZonePayload());
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", content: grounded ?? "I could not process this item right now. Continuing with next question.", createdAt: new Date().toISOString() },
          ]);
        }

        processed += 1;
        nextAllowedSendAt = sentAt + BATCH_MIN_INTERVAL_MS;
      }

      setStatus(`Completed ${processed}/${questions.length} questions.`);
      clearJson();
    },
    [applyAction, remindersRef, setMessages, tasksRef],
  );

  return { runBatchQuestions } as const;
}
