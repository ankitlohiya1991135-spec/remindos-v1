"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BroadcastListItem,
  SendBroadcastRequest,
} from "@repo/admin/types";

const SEGMENTS: Array<{
  value: SendBroadcastRequest["segment"];
  label: string;
  caution?: boolean;
}> = [
  { value: "active_today", label: "Active today" },
  { value: "active_7d", label: "Active this week" },
  // Label says "Staff" not "Admins" — keeps tier hierarchy invisible.
  { value: "admins_only", label: "Staff only" },
  { value: "all", label: "ALL users", caution: true },
];

function formatDateTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function BroadcastsClient({
  viewerUserId,
  viewerRole,
}: {
  viewerUserId: string;
  viewerRole: "admin" | "superadmin";
}) {
  const [broadcasts, setBroadcasts] = useState<BroadcastListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [segment, setSegment] =
    useState<SendBroadcastRequest["segment"]>("active_7d");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/broadcasts", { cache: "no-store" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { broadcasts: BroadcastListItem[] };
      setBroadcasts(data.broadcasts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const canSend = useMemo(
    () => title.trim().length > 0 && body.trim().length > 0 && !sending,
    [title, body, sending],
  );

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    if (segment === "all") {
      const confirmed = confirm(
        "You are about to message EVERY user. Continue?",
      );
      if (!confirmed) return;
    }
    setSending(true);
    setSendError(null);
    setSentNotice(null);
    try {
      const res = await fetch("/api/admin/broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          segment,
        } satisfies SendBroadcastRequest),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { recipientCount: number };
      setSentNotice(`Broadcast sent to ${data.recipientCount} user(s).`);
      setTitle("");
      setBody("");
      void refetch();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleRecall = async (b: BroadcastListItem) => {
    const isOverride =
      viewerRole === "superadmin" && b.senderUserId !== viewerUserId;
    const message = isOverride
      ? `Recall this broadcast sent by ${b.senderDisplay}? (superadmin override)`
      : "Recall this broadcast?";
    if (!confirm(message)) return;
    try {
      const res = await fetch(`/api/admin/broadcasts/${encodeURIComponent(b.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      void refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-5">
      {/* Compose */}
      <form
        onSubmit={handleSend}
        className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
      >
        <h3 className="mb-3 text-sm font-bold text-slate-900 dark:text-slate-100">
          New broadcast
        </h3>
        <div className="grid gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (max 120 chars)"
            maxLength={120}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Body (max 1000 chars)"
            maxLength={1000}
            rows={4}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Segment
            </label>
            <select
              value={segment}
              onChange={(e) =>
                setSegment(e.target.value as SendBroadcastRequest["segment"])
              }
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {SEGMENTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            {segment === "all" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                ⚠ messages everyone
              </span>
            )}
            <button
              type="submit"
              disabled={!canSend}
              className="ml-auto rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send broadcast"}
            </button>
          </div>
          {sentNotice && (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
              {sentNotice}
            </p>
          )}
          {sendError && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
              {sendError}
            </p>
          )}
        </div>
      </form>

      {/* History */}
      <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Recent broadcasts
          </h3>
          {loading && <span className="text-xs text-slate-400">Loading…</span>}
        </header>
        {error && (
          <p className="px-5 py-3 text-xs text-rose-700 dark:text-rose-300">{error}</p>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {broadcasts.length === 0 && !loading && (
            <li className="px-5 py-6 text-center text-sm text-slate-400">
              No broadcasts yet.
            </li>
          )}
          {broadcasts.map((b) => {
            const isOwn = b.senderUserId === viewerUserId;
            const canRecall =
              !b.recalledAt && (isOwn || viewerRole === "superadmin");
            return (
              <li key={b.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {b.title}
                      {b.recalledAt && (
                        <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                          recalled
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Sent by <strong>{b.senderDisplay}</strong> ({b.senderRole}) ·{" "}
                      {formatDateTime(b.createdAt)} · segment{" "}
                      <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px] dark:bg-slate-800">
                        {b.segment}
                      </code>{" "}
                      · {b.recipientCount} recipient(s)
                    </p>
                    {b.recalledAt && (
                      <p className="mt-0.5 text-[11px] text-rose-600 dark:text-rose-400">
                        Recalled {formatDateTime(b.recalledAt)} by{" "}
                        {b.recalledByDisplay ?? b.recalledBy}
                      </p>
                    )}
                  </div>
                  {canRecall && (
                    <button
                      type="button"
                      onClick={() => void handleRecall(b)}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                        isOwn
                          ? "border border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
                          : "bg-rose-600 text-white hover:bg-rose-500"
                      }`}
                      title={
                        isOwn
                          ? "Recall your own broadcast"
                          : "Superadmin override — recall someone else's broadcast"
                      }
                    >
                      {isOwn ? "Recall" : "Recall (override)"}
                    </button>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
                  {b.body}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
