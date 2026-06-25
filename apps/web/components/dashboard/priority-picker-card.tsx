"use client";

/**
 * PriorityPickerCard
 *
 * Rendered inline in chat right after a reminder-creation intent is parsed,
 * before anything is saved. The user picks a feel — Critical / Medium / Chill —
 * instead of a 1-5 star rating, and that maps to a priority value:
 *   Critical -> 5 stars, Medium -> 3 stars, Chill -> 2 stars.
 * Tapping a button fires onAction({ type: "resolve_priority", ...payload, priority })
 * which actually creates the reminder — nothing is saved until the user picks.
 */

import { useState } from "react";
import type { AgentAction, ChatMessageMeta } from "./dashboard-types";

interface Props {
  meta: ChatMessageMeta;
  onAction: (action: AgentAction) => void;
}

const LEVELS = [
  {
    key: "critical",
    label: "Critical",
    sub: "5 stars",
    priority: 5,
    className: "border-red-500/40 bg-red-950/40 hover:bg-red-900/50 text-red-200",
    pickedClassName: "border-red-400/70 bg-red-900/60 ring-1 ring-red-400/50",
  },
  {
    key: "medium",
    label: "Medium",
    sub: "3 stars",
    priority: 3,
    className: "border-amber-500/40 bg-amber-950/40 hover:bg-amber-900/50 text-amber-200",
    pickedClassName: "border-amber-400/70 bg-amber-900/60 ring-1 ring-amber-400/50",
  },
  {
    key: "chill",
    label: "Chill",
    sub: "2 stars",
    priority: 2,
    className: "border-sky-500/40 bg-sky-950/40 hover:bg-sky-900/50 text-sky-200",
    pickedClassName: "border-sky-400/70 bg-sky-900/60 ring-1 ring-sky-400/50",
  },
] as const;

export function PriorityPickerCard({ meta, onAction }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const payload = meta.priorityPickerPayload;
  if (!payload) return null;
  const safePayload = payload;

  function handlePick(level: (typeof LEVELS)[number]) {
    if (picked) return;
    setPicked(level.key);
    onAction({
      type: "resolve_priority",
      title: safePayload.title,
      dueAt: safePayload.dueAt,
      notes: safePayload.notes,
      domain: safePayload.domain,
      recurrence: safePayload.recurrence,
      linkedTaskId: safePayload.linkedTaskId,
      priority: level.priority,
    });
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#1e1830] p-3 shadow-md">
      <p className="mb-2 truncate text-sm font-medium text-white/90">{payload.title}</p>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-violet-400/70">
        How important is this?
      </p>
      <div className="flex gap-2">
        {LEVELS.map((level) => {
          const isPicked = picked === level.key;
          const isDisabled = picked !== null && !isPicked;
          return (
            <button
              key={level.key}
              type="button"
              disabled={isDisabled}
              onClick={() => handlePick(level)}
              className={[
                "flex-1 rounded-xl border px-3 py-2.5 text-center transition-all active:scale-[0.97]",
                isPicked ? level.pickedClassName : level.className,
                isDisabled ? "cursor-not-allowed opacity-40" : "",
              ].join(" ")}
            >
              <div className="text-sm font-semibold">{level.label}</div>
              <div className="mt-0.5 text-[11px] opacity-70">{level.sub}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
