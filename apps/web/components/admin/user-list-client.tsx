"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AdminListedUser } from "@repo/admin/types";

interface UsersResponse {
  users: AdminListedUser[];
  totalCount?: number;
  limitApplied: number;
  truncated: boolean;
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "never";
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "in the future";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.floor(day / 365);
  return `${year}y ago`;
}

function displayName(user: AdminListedUser): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return full || user.username || user.email || user.id;
}

export function AdminUserListClient() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState<"all" | "today" | "week">("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/admin/users", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as UsersResponse;
      })
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
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
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.users.filter((u) => {
      if (filterActive === "today" && !u.activity.activeToday) return false;
      if (filterActive === "week" && u.activity.promptsLast7d === 0) return false;
      if (!q) return true;
      const hay = [
        u.email,
        u.firstName,
        u.lastName,
        u.username,
        u.role,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, search, filterActive]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Loading users…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-300 bg-rose-50 p-6 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
        <p className="font-semibold">Could not load users</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, role…"
          className="flex-1 min-w-[12rem] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
        />
        <div className="flex gap-1.5">
          {(
            [
              { key: "all", label: "All" },
              { key: "today", label: "Active today" },
              { key: "week", label: "Active this week" },
            ] as { key: "all" | "today" | "week"; label: string }[]
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setFilterActive(opt.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                filterActive === opt.key
                  ? "bg-violet-600 text-white"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Truncation notice */}
      {data.truncated && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
          Showing first {data.limitApplied} of {data.totalCount} users.
          Pagination not yet implemented.
        </div>
      )}

      {/* Stats summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total users" value={data.users.length} />
        <StatCard
          label="Active today"
          value={data.users.filter((u) => u.activity.activeToday).length}
        />
        <StatCard
          label="Active this week"
          value={data.users.filter((u) => u.activity.promptsLast7d > 0).length}
        />
        <StatCard
          label="Admins"
          value={data.users.filter((u) => u.role === "admin").length}
        />
      </div>

      {/* User table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-right">Total prompts</th>
                <th className="px-4 py-3 text-right">Last 24h</th>
                <th className="px-4 py-3 text-right">Last 7d</th>
                <th className="px-4 py-3 text-left">Last active</th>
                <th className="px-4 py-3 text-right">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No users match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map((u) => (
                <tr key={u.id} className="transition hover:bg-slate-50 dark:hover:bg-slate-950/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {u.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={u.imageUrl}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                          {(displayName(u)[0] ?? "?").toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                          {displayName(u)}
                        </p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {u.email}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        u.role === "admin"
                          ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-700 dark:text-slate-200">
                    {u.activity.totalPrompts}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-700 dark:text-slate-200">
                    {u.activity.promptsLast24h}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-700 dark:text-slate-200">
                    {u.activity.promptsLast7d}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                    {u.activity.activeToday && (
                      <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                    {formatRelativeTime(u.activity.lastPromptAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="rounded-full border border-violet-200 px-3 py-1 text-xs font-semibold text-violet-700 transition hover:bg-violet-50 dark:border-violet-900/60 dark:text-violet-300 dark:hover:bg-violet-950/40"
                    >
                      Details
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
        {value}
      </p>
    </div>
  );
}
