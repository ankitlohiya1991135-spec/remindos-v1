"use client";

import { useState } from "react";

export function AdminDmPanel({ userId }: { userId: string }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim() || sending) return;
    setSending(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), body: body.trim() }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      setTitle("");
      setBody("");
      setDone("Message delivered.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-2xl border border-cyan-200 bg-cyan-50/30 p-5 dark:border-cyan-900/60 dark:bg-cyan-950/20">
      <header className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
          Message
        </span>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Send direct message
        </h3>
      </header>
      <form onSubmit={handleSend} className="grid gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Subject (max 120 chars)"
          maxLength={120}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message body (max 1000 chars)"
          maxLength={1000}
          rows={3}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={sending || !title.trim() || !body.trim()}
            className="rounded-full bg-cyan-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-cyan-500 disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send to user"}
          </button>
        </div>
        {done && (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
            {done}
          </p>
        )}
        {error && (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
