"use client";

/**
 * DisambigPickerCard
 *
 * Rendered inline in the chat when the server returns multiple candidate
 * reminders for an update operation (reschedule / edit / delete / mark_done / snooze).
 * Shows each candidate as a tappable button — no typing required.
 * On selection it fires onAction({ type: "resolve_disambig", ... }) which
 * applyAction handles to show the appropriate operation card.
 */

import { useState } from "react";
import type { ReminderItem } from "@repo/reminder";
import type { AgentAction, ChatMessageMeta } from "./dashboard-types";

interface Props {
  meta: ChatMessageMeta;
  reminders: ReminderItem[];
  onAction: (action: AgentAction) => void;
}

const OP_LABEL: Record<string, string> = {
  reschedule: "Reschedule",
  edit: "Edit",
  mark_done: "Mark done",
  delete: "Delete",
  snooze: "Snooze",
};

function friendlyTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function DisambigPickerCard({ meta, reminders, onAction }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const {
    disambigCandidateIds = [],
    disambigOp,
    disambigPendingDueAt,
    disambigPendingField,
    disambigPendingValue,
    disambigPendingDelayMinutes,
  } = meta;

  const candidates = disambigCandidateIds
    .map((id) => reminders.find((r) => r.id === id))
    .filter((r): r is ReminderItem => r !== undefined);

  if (!candidates.length || !disambigOp) return null;

  const opLabel = OP_LABEL[disambigOp] ?? "Update";

  function handlePick(reminderId: string) {
    if (selected) return; // already picked
    setSelected(reminderId);
    onAction({
      type: "resolve_disambig",
      targetId: reminderId,
      pendingOp: disambigOp,
      ...(disambigPendingDueAt ? { pendingDueAt: disambigPendingDueAt } : {}),
      ...(disambigPendingField ? { pendingField: disambigPendingField } : {}),
      ...(disambigPendingValue != null ? { pendingValue: disambigPendingValue } : {}),
      ...(disambigPendingDelayMinutes != null ? { pendingDelayMinutes: disambigPendingDelayMinutes } : {}),
    });
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-violet-500/20 bg-[#1e1830] p-3 shadow-md">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-violet-400/70">
        {opLabel} — pick a reminder
      </p>
      <div className="flex flex-col gap-2">
        {candidates.map((r) => {
          const isPicked = selected === r.id;
          const isDisabled = selected !== null && !isPicked;
          return (
            <button
              key={r.id}
              type="button"
              disabled={isDisabled}
              onClick={() => handlePick(r.id)}
              className={[
                "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
                isPicked
                  ? "border-violet-400/60 bg-violet-700/30 ring-1 ring-violet-400/40"
                  : isDisabled
                    ? "cursor-not-allowed border-white/5 bg-white/5 opacity-40"
                    : "border-violet-500/20 bg-[#2a2240] hover:border-violet-400/40 hover:bg-violet-900/30 active:scale-[0.98]",
              ].join(" ")}
            >
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-violet-400/30 bg-violet-900/40">
                {isPicked ? (
                  <svg viewBox="0 0 10 10" className="h-3 w-3 fill-violet-300">
                    <path d="M1.5 5.5L4 8l4.5-5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500/50" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white/90">{r.title}</p>
                {r.dueAt && (
                  <p className="mt-0.5 text-[11px] text-violet-300/60">
                    {friendlyTime(r.dueAt)}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
