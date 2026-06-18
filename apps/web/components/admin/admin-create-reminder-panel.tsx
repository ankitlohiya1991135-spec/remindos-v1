"use client";

import { useState } from "react";

const RECURRENCE = ["none", "daily", "weekly", "monthly"] as const;

/**
 * Admin panel to create a reminder ON BEHALF OF a user. The user is notified via
 * their chat (assistant message), a push notification, and the notification feed.
 */
export function AdminCreateReminderPanel({ userId }: { userId: string }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(""); // datetime-local string
  const [recurrence, setRecurrence] = useState<(typeof RECURRENCE)[number]>("none");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !due || saving) return;
    const dueAt = new Date(due).getTime();
    if (!Number.isFinite(dueAt)) {
      setError("Pick a valid date and time.");
      return;
    }
    setSaving(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/reminder`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), dueAt, recurrence }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { pushed?: number };
      setTitle("");
      setDue("");
      setRecurrence("none");
      setDone(
        `Reminder created. Chat message added${
          data.pushed && data.pushed > 0 ? ` · pushed to ${data.pushed} device(s)` : " · no active push devices"
        }.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-violet-200 bg-violet-50/30 p-5 dark:border-violet-900/60 dark:bg-violet-950/20">
      <header className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
          Reminder
        </span>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Create a reminder for this user
        </h3>
      </header>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Lands in their list, drops a chat message they&apos;ll see on next open, and sends a push.
      </p>
      <form onSubmit={handleSubmit} className="grid gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reminder title"
          maxLength={200}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <div className="flex flex-wrap gap-2">
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as (typeof RECURRENCE)[number])}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            {RECURRENCE.map((r) => (
              <option key={r} value={r}>
                {r === "none" ? "One-time" : `Repeats ${r}`}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={!title.trim() || !due || saving}
          className="justify-self-start rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create reminder"}
        </button>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
        {done ? <p className="text-xs text-emerald-600">{done}</p> : null}
      </form>
    </section>
  );
}
