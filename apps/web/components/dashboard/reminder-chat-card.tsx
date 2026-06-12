"use client";

/**
 * ReminderChatCard
 *
 * Interactive reminder card rendered inline in the chat panel after any
 * reminder operation. Supports the full lifecycle: Done, Snooze, Reschedule,
 * Edit (title / notes / priority / domain / recurrence), and Delete.
 *
 * Actions are dispatched via `onAction(AgentAction)` so they go through the
 * same optimistic-update path used by chat commands — zero code duplication.
 */

import { useState, useCallback, useMemo } from "react";
import type { ReminderItem } from "@repo/reminder";
import type { AgentAction } from "./dashboard-types";
import type { TaskRow } from "./task-panels";

// ── Domain colours (mirrors reminder-card.tsx) ────────────────────────────
const DOMAIN_COLORS: Record<string, string> = {
  health:  "#10b981",
  finance: "#06b6d4",
  career:  "#6366f1",
  hobby:   "#7c3aed",
  fun:     "#f59e0b",
};

const DOMAINS = ["health", "finance", "career", "hobby", "fun"] as const;
const RECURRENCES = ["none", "daily", "weekly", "monthly"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

/** Format a JS Date/ISO string for <input type="datetime-local"> */
function toDatetimeLocal(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  } catch {
    return "";
  }
}

/** Human-readable short date/time label */
function friendlyTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// ── Sub-component: priority stars ─────────────────────────────────────────

function PrioritySelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`text-lg leading-none transition-opacity ${
            n <= value ? "text-amber-400" : "text-white/20"
          }`}
          aria-label={`Priority ${n}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface ReminderChatCardProps {
  reminderId: string;
  reminders: ReminderItem[];
  tasks: TaskRow[];
  onAction: (action: AgentAction) => void;
  /** Open the card directly in this mode — used when the card is a chat
   *  operation preview (the system parsed an intent; the user confirms via Save). */
  initialMode?: "default" | "reschedule" | "edit";
  /** Prefilled values for reschedule/edit when opened as an operation preview.
   *  Only the changed fields are set; the rest fall back to the reminder. */
  prefill?: {
    dueAt?: string;
    title?: string;
    notes?: string;
    priority?: number;
    domain?: string | null;
    recurrence?: string;
  };
}

type CardMode = "default" | "reschedule" | "edit";

export function ReminderChatCard({
  reminderId,
  reminders,
  tasks,
  onAction,
  initialMode,
  prefill,
}: ReminderChatCardProps) {
  const reminder = reminders.find((r) => r.id === reminderId);
  const [mode, setMode] = useState<CardMode>(initialMode ?? "default");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // ── Reschedule state (prefill wins over the reminder's current dueAt) ─────
  const [rescheduleValue, setRescheduleValue] = useState(() =>
    prefill?.dueAt
      ? toDatetimeLocal(prefill.dueAt)
      : reminder
        ? toDatetimeLocal(reminder.dueAt)
        : "",
  );

  // ── Edit state (prefill merges over the reminder's current values) ────────
  const [editTitle, setEditTitle]           = useState(prefill?.title ?? reminder?.title ?? "");
  const [editNotes, setEditNotes]           = useState(prefill?.notes ?? reminder?.notes ?? "");
  const [editPriority, setEditPriority]     = useState(prefill?.priority ?? reminder?.priority ?? 3);
  const [editDomain, setEditDomain]         = useState<string>((prefill?.domain ?? reminder?.domain) ?? "");
  const [editRecurrence, setEditRecurrence] = useState<string>(
    prefill?.recurrence ?? reminder?.recurrence ?? "none",
  );

  const linkedTask = useMemo(
    () => (reminder?.linkedTaskId ? tasks.find((t) => t.id === reminder.linkedTaskId) : null),
    [reminder?.linkedTaskId, tasks],
  );

  // ── Open edit: seed form from current reminder state ───────────────────
  const openEdit = useCallback(() => {
    if (!reminder) return;
    setEditTitle(reminder.title);
    setEditNotes(reminder.notes ?? "");
    setEditPriority(reminder.priority ?? 3);
    setEditDomain(reminder.domain ?? "");
    setEditRecurrence(reminder.recurrence ?? "none");
    setMode("edit");
  }, [reminder]);

  // ── Open reschedule: seed datetime from current dueAt ──────────────────
  const openReschedule = useCallback(() => {
    if (!reminder) return;
    setRescheduleValue(toDatetimeLocal(reminder.dueAt));
    setMode("reschedule");
  }, [reminder]);

  // ── Action dispatchers ─────────────────────────────────────────────────

  const dispatchDone = useCallback(() => {
    onAction({ type: "mark_done", targetId: reminderId });
  }, [onAction, reminderId]);

  const dispatchSnooze = useCallback(() => {
    onAction({ type: "snooze_reminder", targetId: reminderId, delayMinutes: 60 });
  }, [onAction, reminderId]);

  const dispatchDelete = useCallback(() => {
    onAction({ type: "delete_reminder", targetId: reminderId });
    setDeleteConfirm(false);
  }, [onAction, reminderId]);

  const dispatchReschedule = useCallback(() => {
    if (!rescheduleValue) return;
    const ms = new Date(rescheduleValue).getTime();
    if (!Number.isFinite(ms)) return;
    onAction({ type: "reschedule_reminder", targetId: reminderId, dueAt: new Date(ms).toISOString() });
    setMode("default");
  }, [onAction, reminderId, rescheduleValue]);

  const setQuickReschedule = useCallback(
    (offsetMs: number) => {
      const d = new Date(Date.now() + offsetMs);
      // Round to nearest 5 min for cleanliness
      d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
      setRescheduleValue(toDatetimeLocal(d.toISOString()));
    },
    [],
  );

  const dispatchEdit = useCallback(() => {
    if (!reminder) return;
    const hasChanges =
      editTitle.trim() !== reminder.title ||
      editNotes.trim() !== (reminder.notes ?? "") ||
      editPriority !== (reminder.priority ?? 3) ||
      editDomain !== (reminder.domain ?? "") ||
      editRecurrence !== (reminder.recurrence ?? "none");
    if (!hasChanges) { setMode("default"); return; }

    onAction({
      type: "edit_reminder",
      targetId: reminderId,
      newTitle: editTitle.trim() !== reminder.title ? editTitle.trim() : undefined,
      newNotes: editNotes.trim() !== (reminder.notes ?? "") ? editNotes.trim() : undefined,
      newPriority: editPriority !== (reminder.priority ?? 3) ? editPriority : undefined,
      newDomain: editDomain !== (reminder.domain ?? "") ? (editDomain || null) : undefined,
      newRecurrence:
        editRecurrence !== (reminder.recurrence ?? "none")
          ? (editRecurrence as "none" | "daily" | "weekly" | "monthly")
          : undefined,
    });
    setMode("default");
  }, [reminder, reminderId, editTitle, editNotes, editPriority, editDomain, editRecurrence, onAction]);

  // ── Render: Not found state ─────────────────────────────────────────────
  if (!reminder) {
    return (
      <div className="rounded-[20px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/40 italic">
        Reminder no longer exists.
      </div>
    );
  }

  const isDone = reminder.status === "done" || reminder.status === "archived";
  const domainColor = reminder.domain ? (DOMAIN_COLORS[reminder.domain] ?? "#94a3b8") : "#94a3b8";

  const statusColor =
    isDone                                                        ? "#10b981" :
    new Date(reminder.dueAt).getTime() < Date.now()              ? "#f43f5e" :
    new Date(reminder.dueAt).getTime() < Date.now() + 2*3600_000 ? "#f59e0b" :
                                                                    "#7c3aed";

  return (
    <div
      className={`rounded-[20px] border px-3.5 py-3 text-sm transition ${
        isDone
          ? "border-white/10 bg-emerald-950/30"
          : "border-white/15 bg-white/[0.06]"
      }`}
      style={{ maxWidth: "42rem" }}
    >
      {/* ── Top row: status dot + title ──────────────────────────────── */}
      <div className="flex items-start gap-2.5">
        <span
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: isDone ? "#10b981" : statusColor }}
        />
        <div className="min-w-0 flex-1">
          <p className={`font-semibold leading-snug ${isDone ? "text-white/40 line-through" : "text-white/90"}`}>
            {reminder.title}
            {(reminder.priority ?? 0) > 0 && (
              <span className="ml-1 text-amber-400">
                {"★".repeat(reminder.priority ?? 0)}
              </span>
            )}
          </p>
          <p className={`mt-0.5 text-[11px] font-medium ${isDone ? "text-emerald-400" : "text-white/50"}`}>
            {friendlyTime(reminder.dueAt)}
          </p>
        </div>
      </div>

      {/* ── Badges ────────────────────────────────────────────────────── */}
      <div className="mt-2 flex flex-wrap gap-1">
        {reminder.recurrence && reminder.recurrence !== "none" && (
          <span className="rounded-full bg-teal-900/50 px-2 py-0.5 text-[9px] font-bold uppercase text-teal-300">
            ↻ {reminder.recurrence}
          </span>
        )}
        {linkedTask ? (
          <span className="rounded-full bg-indigo-900/50 px-2 py-0.5 text-[9px] font-bold text-indigo-300">
            {linkedTask.title}
          </span>
        ) : (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-bold uppercase text-white/40">
            ADHOC
          </span>
        )}
        {reminder.domain && (
          <span
            className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase"
            style={{ background: `${domainColor}22`, color: domainColor }}
          >
            {reminder.domain}
          </span>
        )}
      </div>

      {/* ── Notes (default mode only) ─────────────────────────────────── */}
      {reminder.notes && mode === "default" && !isDone && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/50">
          {reminder.notes}
        </p>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          DEFAULT MODE — quick action buttons
         ═══════════════════════════════════════════════════════════════════ */}
      {mode === "default" && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {isDone ? (
            /* Restore button for done/archived items */
            <button
              type="button"
              onClick={() => onAction({ type: "edit_reminder", targetId: reminderId, newStatus: "pending" })}
              className="flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-900/20 px-2.5 py-1 text-[10px] font-bold text-violet-300 transition hover:bg-violet-900/40"
              title="Restore this reminder to pending"
            >
              ↩ Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={dispatchDone}
                className="flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-emerald-500"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                  <path d="m5 12 4 4 10-10"/>
                </svg>
                Done
              </button>
              <button
                type="button"
                onClick={dispatchSnooze}
                className="rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold text-white/70 transition hover:bg-white/10"
              >
                +1h
              </button>
              <button
                type="button"
                onClick={openReschedule}
                className="rounded-full border border-violet-500/40 bg-violet-900/30 px-2.5 py-1 text-[10px] font-bold text-violet-300 transition hover:bg-violet-900/50"
              >
                Reschedule
              </button>
              <button
                type="button"
                onClick={openEdit}
                className="rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold text-white/70 transition hover:bg-white/10"
              >
                Edit
              </button>
              {deleteConfirm ? (
                <>
                  <button
                    type="button"
                    onClick={dispatchDelete}
                    className="rounded-full bg-rose-600 px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-rose-500"
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(false)}
                    className="rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold text-white/50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(true)}
                  className="rounded-full border border-rose-800/50 bg-rose-950/30 px-2.5 py-1 text-[10px] font-bold text-rose-400 transition hover:bg-rose-900/40"
                >
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          RESCHEDULE MODE
         ═══════════════════════════════════════════════════════════════════ */}
      {mode === "reschedule" && (
        <div className="mt-3 space-y-2.5">
          {/* Quick presets */}
          <div className="flex flex-wrap gap-1.5">
            {[
              { label: "Today",     ms: 0,            sameDay: true },
              { label: "Tomorrow",  ms: 24 * 3600_000, sameDay: false },
              { label: "+1h",       ms: 3600_000,      sameDay: false },
              { label: "+1 day",    ms: 24 * 3600_000, sameDay: false },
            ].map(({ label, ms, sameDay }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (sameDay && label === "Today") {
                    // Set to today at the reminder's original time-of-day
                    const orig = new Date(reminder.dueAt);
                    const today = new Date();
                    orig.setFullYear(today.getFullYear(), today.getMonth(), today.getDate());
                    // Guard: if that time is already past, bump to tomorrow so we don't
                    // create an immediately-overdue reminder
                    if (orig.getTime() <= Date.now()) {
                      orig.setDate(orig.getDate() + 1);
                    }
                    setRescheduleValue(toDatetimeLocal(orig.toISOString()));
                  } else {
                    setQuickReschedule(ms);
                  }
                }}
                className="rounded-full border border-violet-500/40 bg-violet-900/20 px-2.5 py-1 text-[10px] font-bold text-violet-300 transition hover:bg-violet-900/50"
              >
                {label}
              </button>
            ))}
          </div>
          {/* Custom datetime picker */}
          <input
            type="datetime-local"
            value={rescheduleValue}
            onChange={(e) => setRescheduleValue(e.target.value)}
            className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-[12px] text-white/80 outline-none focus:border-violet-500/50"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={dispatchReschedule}
              disabled={!rescheduleValue}
              className="rounded-full bg-violet-600 px-4 py-1.5 text-[11px] font-bold text-white transition hover:bg-violet-500 disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setMode("default")}
              className="rounded-full border border-white/15 px-4 py-1.5 text-[11px] font-bold text-white/50 transition hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          EDIT MODE
         ═══════════════════════════════════════════════════════════════════ */}
      {mode === "edit" && (
        <div className="mt-3 space-y-2.5">
          {/* Title */}
          <div>
            <label className="mb-1 block text-[9px] font-bold uppercase tracking-[0.15em] text-white/40">Title</label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-[13px] text-white/90 outline-none focus:border-violet-500/50"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="mb-1 block text-[9px] font-bold uppercase tracking-[0.15em] text-white/40">Notes</label>
            <textarea
              rows={2}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-[12px] text-white/80 outline-none focus:border-violet-500/50"
              placeholder="Optional notes…"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="mb-1 block text-[9px] font-bold uppercase tracking-[0.15em] text-white/40">Priority</label>
            <PrioritySelector value={editPriority} onChange={setEditPriority} />
          </div>

          {/* Domain */}
          <div>
            <label className="mb-1 block text-[9px] font-bold uppercase tracking-[0.15em] text-white/40">Domain</label>
            <div className="flex flex-wrap gap-1">
              {DOMAINS.map((d) => {
                const c = DOMAIN_COLORS[d];
                const active = editDomain === d;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setEditDomain(active ? "" : d)}
                    className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase transition"
                    style={{
                      background: active ? `${c}33` : "rgba(255,255,255,0.07)",
                      color: active ? c : "rgba(255,255,255,0.45)",
                      border: `1px solid ${active ? `${c}55` : "rgba(255,255,255,0.1)"}`,
                    }}
                  >
                    {d}
                  </button>
                );
              })}
              {editDomain && (
                <button
                  type="button"
                  onClick={() => setEditDomain("")}
                  className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-bold uppercase text-white/30 transition hover:text-white/50"
                >
                  none
                </button>
              )}
            </div>
          </div>

          {/* Recurrence */}
          <div>
            <label className="mb-1 block text-[9px] font-bold uppercase tracking-[0.15em] text-white/40">Recurrence</label>
            <div className="flex flex-wrap gap-1">
              {RECURRENCES.map((r) => {
                const active = editRecurrence === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setEditRecurrence(r)}
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase transition ${
                      active
                        ? "border border-teal-500/50 bg-teal-900/40 text-teal-300"
                        : "border border-white/10 bg-white/5 text-white/40 hover:text-white/60"
                    }`}
                  >
                    {r === "none" ? "One-time" : r}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Save / Cancel */}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={dispatchEdit}
              className="rounded-full bg-violet-600 px-4 py-1.5 text-[11px] font-bold text-white transition hover:bg-violet-500"
            >
              Save changes
            </button>
            <button
              type="button"
              onClick={() => setMode("default")}
              className="rounded-full border border-white/15 px-4 py-1.5 text-[11px] font-bold text-white/50 transition hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
