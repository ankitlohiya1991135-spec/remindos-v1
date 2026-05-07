"use client";

import { useEffect, useMemo, useState } from "react";
import { AUDIT_ACTIONS, type AuditAction, type AuditLogEntry } from "@repo/admin/types";

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const ACTION_COLORS: Record<AuditAction, string> = {
  ROLE_CHANGED: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  DISPLAY_ROLE_CHANGED: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  USER_DEACTIVATED: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  USER_REACTIVATED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  USER_HARD_DELETED: "bg-rose-200 text-rose-900 dark:bg-rose-900/60 dark:text-rose-200",
  USER_SESSIONS_REVOKED: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  CHAT_HISTORY_RESET: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  BROADCAST_SENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  BROADCAST_RECALLED: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
};

export function AuditLogClient() {
  const [events, setEvents] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<"all" | AuditAction>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/admin/audit?limit=500", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as { events: AuditLogEntry[] };
      })
      .then((data) => {
        if (!cancelled) {
          setEvents(data.events);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((ev) => {
      if (actionFilter !== "all" && ev.action !== actionFilter) return false;
      if (!q) return true;
      const hay = [
        ev.actorDisplay,
        ev.actorUserId,
        ev.targetDisplay ?? "",
        ev.targetUserId ?? "",
        ev.action,
        ev.errorMessage ?? "",
        JSON.stringify(ev.metadata ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [events, actionFilter, search]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Loading audit log…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-300 bg-rose-50 p-6 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
        <p className="font-semibold">Could not load audit log</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search actor, target, action, metadata…"
          className="flex-1 min-w-[14rem] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value as typeof actionFilter)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="all">All actions</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
            <tr>
              <th className="px-4 py-3 text-left">When</th>
              <th className="px-4 py-3 text-left">Actor</th>
              <th className="px-4 py-3 text-left">Action</th>
              <th className="px-4 py-3 text-left">Target</th>
              <th className="px-4 py-3 text-left">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No matching events.
                </td>
              </tr>
            )}
            {filtered.map((ev) => (
              <tr
                key={ev.id}
                className={`transition hover:bg-slate-50 dark:hover:bg-slate-950/50 ${
                  ev.outcome === "error" ? "bg-rose-50/40 dark:bg-rose-950/20" : ""
                }`}
              >
                <td className="px-4 py-3 align-top text-xs text-slate-500 dark:text-slate-400">
                  {formatDateTime(ev.createdAt)}
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="text-sm text-slate-800 dark:text-slate-200">
                    {ev.actorDisplay}
                  </div>
                  <div className="text-[10px] text-slate-400">{ev.actorRole}</div>
                </td>
                <td className="px-4 py-3 align-top">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      ACTION_COLORS[ev.action] ??
                      "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {ev.action}
                  </span>
                  {ev.outcome === "error" && (
                    <span className="ml-1.5 rounded-full bg-rose-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-900 dark:bg-rose-900/60 dark:text-rose-200">
                      error
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 align-top text-sm text-slate-700 dark:text-slate-200">
                  {ev.targetDisplay ?? (ev.targetUserId ? <code>{ev.targetUserId}</code> : "—")}
                </td>
                <td className="px-4 py-3 align-top">
                  {ev.metadata !== undefined && (
                    <pre className="max-w-md overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-700 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(ev.metadata, null, 2)}
                    </pre>
                  )}
                  {ev.errorMessage && (
                    <p className="mt-1 text-xs text-rose-700 dark:text-rose-400">
                      {ev.errorMessage}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
