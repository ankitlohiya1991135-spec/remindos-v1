"use client";

/**
 * CreateReminderOverlay
 *
 * Full-screen / bottom-sheet form for creating or editing a reminder.
 * Manages its own form state internally — the parent only needs to
 * pass in the editing reminder (or null for create mode) plus a few
 * callbacks.
 *
 * Extracted from dashboard-workspace.tsx.
 */

import { useState, type FormEvent } from "react";
import type { ReminderItem, ReminderRecurrence, LifeDomain } from "@repo/reminder";
import type { TaskRow } from "./task-panels";
import { currentDateTimeLocalValue } from "./dashboard-utils";

export interface CreateReminderOverlayProps {
  /** null = create mode; non-null = edit mode */
  editingReminder: ReminderItem | null;
  /** Pre-linked task when opening from a task context */
  initialLinkedTaskId?: string;
  reminders: ReminderItem[];
  tasks: TaskRow[];
  onClose: () => void;
  onDeleteReminder: (id: string) => void;
  onSaveSuccess: (info: { title: string; time: string }) => void;
  refreshReminders: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  onShowToast: (msg: string) => void;
}

export function CreateReminderOverlay({
  editingReminder,
  initialLinkedTaskId,
  reminders,
  tasks,
  onClose,
  onDeleteReminder,
  onSaveSuccess,
  refreshReminders,
  refreshTasks,
  onShowToast,
}: CreateReminderOverlayProps) {
  const localNow = currentDateTimeLocalValue();

  // ── Form state ────────────────────────────────────────────────────────────
  const [newTitle, setNewTitle] = useState(editingReminder?.title ?? "");
  const [newDate, setNewDate] = useState(() => {
    if (editingReminder) {
      const dueDate = new Date(editingReminder.dueAt);
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: localTz, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(dueDate);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    }
    return localNow.slice(0, 10);
  });
  const [newTime, setNewTime] = useState(() => {
    if (editingReminder) {
      const dueDate = new Date(editingReminder.dueAt);
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: localTz, hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(dueDate);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("hour").replace("24", "00")}:${get("minute")}`;
    }
    return localNow.slice(11, 16);
  });
  const [reminderStars, setReminderStars] = useState(() => {
    if (editingReminder) {
      const p = editingReminder.priority;
      return typeof p === "number" && p >= 1 && p <= 5 ? p : 0;
    }
    return 3;
  });
  const [newRecurrence, setNewRecurrence] = useState<ReminderRecurrence | "none">(
    editingReminder?.recurrence ?? "none",
  );
  const [newNotes, setNewNotes] = useState(editingReminder?.notes ?? "");
  const [reminderLinkedTaskId, setReminderLinkedTaskId] = useState(
    editingReminder?.linkedTaskId ?? initialLinkedTaskId ?? "",
  );
  const [reminderDomain, setReminderDomain] = useState<"" | LifeDomain>(
    (editingReminder?.domain as LifeDomain | undefined) ?? "",
  );
  // In edit mode: auto-expand the notes/task section when data is already there
  const [showReminderInlineTask, setShowReminderInlineTask] = useState(
    !!(editingReminder?.notes || editingReminder?.linkedTaskId),
  );
  // Status — editable in edit mode so users can reactivate missed/done reminders
  const [reminderStatus, setReminderStatus] = useState<"pending" | "done" | "archived">(
    editingReminder?.status ?? "pending",
  );
  const [reminderInlineTaskTitle, setReminderInlineTaskTitle] = useState("");
  const [reminderInlineTaskDue, setReminderInlineTaskDue] = useState(currentDateTimeLocalValue());
  const [reminderInlineTaskSaving, setReminderInlineTaskSaving] = useState(false);
  const [createFormError, setCreateFormError] = useState<string | null>(null);

  // Capture the original date/time so we know whether the user actually changed
  // them. We only enforce "must be future" when the date/time is newly chosen.
  const [originalDate] = useState(newDate);
  const [originalTime] = useState(newTime);

  const getMinDate = () => {
    // In edit mode don't restrict the date picker — the existing due date may
    // already be in the past and must remain selectable without being blocked.
    if (editingReminder) return undefined;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // ── Create inline task ────────────────────────────────────────────────────
  const handleCreateInlineTask = async () => {
    const title = reminderInlineTaskTitle.trim();
    if (!title) {
      setCreateFormError("Enter a name for the new task.");
      return;
    }
    setReminderInlineTaskSaving(true);
    setCreateFormError(null);
    try {
      let dueAt: number | undefined;
      if (reminderInlineTaskDue.trim()) {
        const ms = new Date(reminderInlineTaskDue).getTime();
        if (Number.isFinite(ms)) dueAt = ms;
      }
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, priority: 3, dueAt, status: "pending" }),
      });
      const data = (await res.json()) as { task?: { _id?: string }; error?: string };
      if (!res.ok) {
        setCreateFormError(data.error ?? "Could not create task.");
        return;
      }
      const tid = data.task?._id;
      if (tid) {
        setReminderLinkedTaskId(String(tid));
        await refreshTasks();
        setShowReminderInlineTask(false);
        setReminderInlineTaskTitle("");
        setReminderInlineTaskDue(currentDateTimeLocalValue());
      }
    } catch {
      setCreateFormError("Network error creating task.");
    } finally {
      setReminderInlineTaskSaving(false);
    }
  };

  // ── Form submit ───────────────────────────────────────────────────────────
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newTitle.trim()) {
      const msg = "Title is required.";
      setCreateFormError(msg); onShowToast(msg); return;
    }
    if (!newDate) {
      const msg = "Date is required.";
      setCreateFormError(msg); onShowToast(msg); return;
    }
    if (!newTime) {
      const msg = "Time is required.";
      setCreateFormError(msg); onShowToast(msg); return;
    }
    if (reminderStars < 1 || reminderStars > 5) {
      const msg = "Choose a priority: tap 1–5 stars.";
      setCreateFormError(msg); onShowToast(msg); return;
    }
    setCreateFormError(null);
    const dueAt = new Date(`${newDate}T${newTime}`).toISOString();
    const dueAtMs = new Date(dueAt).getTime();
    if (!Number.isFinite(dueAtMs)) { setCreateFormError("Invalid date or time."); return; }

    // Future-date guard:
    //   • Create mode  → always required.
    //   • Edit mode    → only when the user actually changed the date or time
    //                    (the original due date might already be in the past for
    //                    missed/overdue reminders, and that's fine to keep).
    const dateOrTimeChanged = newDate !== originalDate || newTime !== originalTime;
    if (!editingReminder && dueAtMs <= Date.now()) {
      setCreateFormError("Date and time must be in the future."); return;
    }
    if (editingReminder && dateOrTimeChanged && dueAtMs <= Date.now()) {
      setCreateFormError("New date and time must be in the future."); return;
    }

    if (editingReminder) {
      // ── Edit mode ─────────────────────────────────────────────────────────
      try {
        const canLink = editingReminder.access !== "shared";
        const linkPayload: Record<string, unknown> = {};
        if (canLink) {
          linkPayload.linkedTaskId = reminderLinkedTaskId.trim() || null;
          linkPayload.domain = reminderDomain || null;
        }
        // Only include dueAt when the user actually changed the date/time —
        // otherwise the API's future-date guard would reject edits to missed
        // reminders whose original timestamp is already in the past.
        const patchBody: Record<string, unknown> = {
          title: newTitle.trim(), recurrence: newRecurrence,
          notes: newNotes.trim() ? newNotes.trim() : undefined,
          priority: reminderStars, status: reminderStatus, ...linkPayload,
        };
        if (dateOrTimeChanged) patchBody.dueAt = dueAtMs;

        const res = await fetch(`/api/reminders/${editingReminder.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) { setCreateFormError(data.error ?? "Could not update reminder."); return; }
        await refreshReminders();
      } catch {
        setCreateFormError("Network error. Try again."); return;
      }
    } else {
      // ── Create mode ───────────────────────────────────────────────────────
      const isDuplicate = reminders.some(
        (item) =>
          item.status === "pending" &&
          item.title.trim().toLowerCase() === newTitle.trim().toLowerCase() &&
          new Date(item.dueAt).getTime() === dueAtMs,
      );
      if (isDuplicate) { onClose(); return; }

      try {
        const createBody: Record<string, unknown> = {
          title: newTitle.trim(), dueAt: dueAtMs, recurrence: newRecurrence,
          notes: newNotes.trim() ? newNotes.trim() : undefined,
          priority: reminderStars,
        };
        if (reminderLinkedTaskId.trim()) createBody.linkedTaskId = reminderLinkedTaskId.trim();
        if (reminderDomain) createBody.domain = reminderDomain;

        const res = await fetch("/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBody),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; created?: boolean };
        if (!res.ok) { setCreateFormError(data.error ?? "Could not save reminder."); return; }
        await refreshReminders();
        onSaveSuccess({
          title: newTitle.trim(),
          time: new Date(`${newDate}T${newTime}`).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          }),
        });
        onClose();
        return;
      } catch {
        setCreateFormError("Network error. Try again."); return;
      }
    }
    onClose();
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const editingReminderIsShared = editingReminder?.access === "shared";

  const domainChipColors: Record<string, { active: string; text: string }> = {
    health:  { active: "#10b981", text: "#065f46" },
    finance: { active: "#06b6d4", text: "#155e75" },
    career:  { active: "#6366f1", text: "#312e81" },
    hobby:   { active: "#7c3aed", text: "#4c1d95" },
    fun:     { active: "#f59e0b", text: "#78350f" },
  };

  return (
    <div
      data-testid="reminder-form-overlay"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ── Handle bar (mobile) ── */}
        <div className="flex shrink-0 justify-center pt-2.5 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-slate-200" />
        </div>

        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between px-5 py-3">
          {editingReminder ? (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1 text-slate-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="m15 18-6-6 6-6"/></svg>
              <span className="text-[15px] font-semibold text-slate-700">Edit Reminder</span>
            </button>
          ) : (
            <h3 className="text-[17px] font-extrabold text-slate-900">New Reminder</h3>
          )}
          {editingReminder ? (
            <button
              type="button"
              form="reminder-form"
              className="rounded-full bg-violet-600 px-5 py-2 text-[13px] font-bold text-white shadow-sm"
              onClick={(e) => { e.preventDefault(); void (document.getElementById("reminder-form") as HTMLFormElement | null)?.requestSubmit(); }}
              data-testid="reminder-save-button"
            >
              Update
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          )}
        </div>

        <form
          id="reminder-form"
          className="min-h-0 flex-1 overflow-y-auto"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <div className="grid gap-5 px-5 pb-6 pt-1">

            {/* Title input */}
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="What do you need to remember?"
              data-testid="reminder-title-input"
              className="w-full border-0 border-b border-slate-200 pb-2 text-[15px] font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-violet-400"
              autoFocus
            />

            {/* Date + Time chips */}
            <div className="grid grid-cols-2 gap-3">
              {/* DATE chip — native date picker, styled with hover affordance for web */}
              <label className="group flex cursor-pointer flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">DATE</span>
                <div className="relative">
                  <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] font-semibold text-slate-700 transition-colors group-hover:border-violet-400 group-hover:bg-violet-50">
                    <span>📅</span>
                    <span className="flex-1 truncate">{newDate ? new Date(`${newDate}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Pick date"}</span>
                    {/* Pencil icon — subtle on rest, violet on hover */}
                    <svg className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </div>
                  <input
                    type="date"
                    {...(getMinDate() ? { min: getMinDate() } : {})}
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    data-testid="reminder-date-input"
                    title="Click to change date"
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </div>
              </label>
              {/* TIME chip */}
              <label className="group flex cursor-pointer flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">TIME</span>
                <div className="relative">
                  <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] font-semibold text-slate-700 transition-colors group-hover:border-violet-400 group-hover:bg-violet-50">
                    <span>🕐</span>
                    <span className="flex-1 truncate">{newTime ? new Date(`1970-01-01T${newTime}`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "Pick time"}</span>
                    <svg className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </div>
                  <input
                    type="time"
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                    data-testid="reminder-time-input"
                    title="Click to change time"
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </div>
              </label>
            </div>

            {/* Priority stars */}
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">PRIORITY <span className="text-rose-400">*</span></p>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setReminderStars(n)}
                    className={`flex h-11 w-11 items-center justify-center rounded-2xl border text-xl transition ${
                      n <= reminderStars
                        ? "border-amber-300 bg-amber-50 text-amber-400"
                        : "border-slate-200 bg-slate-50 text-slate-300"
                    }`}
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            {/* Repeat chips */}
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">REPEAT</p>
              <div className="flex flex-wrap gap-2">
                {(["none", "daily", "weekly", "monthly"] as const).map((r) => {
                  const label = r === "none" ? "None" : r[0]!.toUpperCase() + r.slice(1);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setNewRecurrence(r)}
                      data-testid={r === "none" ? "reminder-recurrence-select" : undefined}
                      className={`rounded-full px-4 py-1.5 text-[12px] font-bold transition ${
                        newRecurrence === r
                          ? "bg-violet-600 text-white"
                          : "border border-slate-200 bg-white text-slate-600"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Domain chips */}
            <div className={editingReminderIsShared ? "pointer-events-none opacity-60" : ""}>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">DOMAIN</p>
              <div className="flex flex-wrap gap-2">
                {(["health", "finance", "career", "hobby", "fun"] as const).map((d) => {
                  const active = reminderDomain === d;
                  const c = domainChipColors[d]!;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setReminderDomain(active ? "" : d)}
                      data-testid="reminder-domain-select"
                      className="rounded-full px-4 py-1.5 text-[12px] font-bold transition"
                      style={active
                        ? { background: `${c.active}22`, color: c.active, border: `1.5px solid ${c.active}` }
                        : { background: "#f8fafc", color: "#64748b", border: "1.5px solid #e2e8f0" }
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Status — edit mode only, lets user reactivate missed or done reminders */}
            {editingReminder && (
              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">STATUS</p>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      { value: "pending",  label: "Pending",  emoji: "🔔" },
                      { value: "done",     label: "Done",     emoji: "✅" },
                      { value: "archived", label: "Archived", emoji: "📦" },
                    ] as const
                  ).map(({ value, label, emoji }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setReminderStatus(value)}
                      className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-bold transition ${
                        reminderStatus === value
                          ? value === "done"
                            ? "bg-emerald-600 text-white"
                            : value === "archived"
                              ? "bg-slate-600 text-white"
                              : "bg-violet-600 text-white"
                          : "border border-slate-200 bg-white text-slate-600"
                      }`}
                    >
                      <span>{emoji}</span>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* More options expandable */}
            <div>
              <button
                type="button"
                onClick={() => setShowReminderInlineTask((v) => !v)}
                data-testid="reminder-inline-task-toggle"
                className="flex items-center gap-1.5 text-[12px] font-medium text-slate-400"
              >
                <span className={`text-base transition-transform ${showReminderInlineTask ? "rotate-90" : ""}`}>›</span>
                {editingReminder ? "Notes & task link" : "More options (link task, notes…)"}
              </button>

              {showReminderInlineTask && (
                <div className="mt-3 grid gap-4">
                  {/* Linked task */}
                  <div className={editingReminderIsShared ? "pointer-events-none opacity-60" : ""}>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">LINKED TASK</p>
                    {reminderLinkedTaskId ? (
                      <div className="flex items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-3 py-2.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 shrink-0"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 12 2 2 4-4"/></svg>
                        <span className="flex-1 text-[13px] font-semibold text-indigo-700">
                          {tasks.find((t) => t.id === reminderLinkedTaskId)?.title ?? "Task"}
                        </span>
                        <button type="button" onClick={() => setReminderLinkedTaskId("")} className="text-[11px] font-bold text-indigo-500">Change</button>
                      </div>
                    ) : (
                      <select
                        value={reminderLinkedTaskId}
                        onChange={(e) => setReminderLinkedTaskId(e.target.value)}
                        disabled={editingReminderIsShared}
                        data-testid="reminder-task-select"
                        className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none focus:border-violet-400"
                      >
                        <option value="">None — counts as ADHOC</option>
                        {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                      </select>
                    )}
                  </div>

                  {/* Notes textarea */}
                  <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">NOTES</p>
                    <textarea
                      rows={3}
                      value={newNotes}
                      onChange={(e) => setNewNotes(e.target.value)}
                      placeholder="Add notes…"
                      data-testid="reminder-notes-input"
                      className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none focus:border-violet-400"
                    />
                  </div>

                  {/* Inline task creator — available in both create and edit mode */}
                  {!editingReminderIsShared && (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/90 px-3 py-3">
                      <p className="mb-2 text-[11px] font-bold text-violet-700">+ Create new task &amp; link it</p>
                      <div className="grid gap-2">
                        <input
                          value={reminderInlineTaskTitle}
                          onChange={(e) => setReminderInlineTaskTitle(e.target.value)}
                          placeholder="New task title"
                          data-testid="reminder-inline-task-title-input"
                          className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        />
                        <input
                          type="datetime-local"
                          value={reminderInlineTaskDue}
                          onChange={(e) => setReminderInlineTaskDue(e.target.value)}
                          data-testid="reminder-inline-task-due-input"
                          className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        />
                        <button
                          type="button"
                          disabled={reminderInlineTaskSaving}
                          onClick={() => void handleCreateInlineTask()}
                          data-testid="reminder-inline-task-save-button"
                          className="rounded-full bg-violet-600 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          {reminderInlineTaskSaving ? "Creating…" : "Create task & link"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Error */}
            {createFormError && (
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-600" role="alert" data-testid="reminder-form-error">
                {createFormError}
              </p>
            )}

            {/* Delete button (edit mode only) */}
            {editingReminder && (
              <button
                type="button"
                onClick={() => onDeleteReminder(editingReminder.id)}
                className="w-full rounded-2xl bg-rose-500 py-3.5 text-[14px] font-bold text-white"
              >
                Delete Reminder
              </button>
            )}

            {/* Save button (create mode) */}
            {!editingReminder && (
              <button
                type="submit"
                data-testid="reminder-save-button"
                className="w-full rounded-2xl bg-violet-600 py-3.5 text-[15px] font-bold text-white shadow-md shadow-violet-500/30"
              >
                Save Reminder
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
