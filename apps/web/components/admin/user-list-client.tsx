"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AdminListedUser,
  BulkDeactivateResult,
  OrgCostOverview,
} from "@repo/admin/types";
import { USER_METADATA_CHANGED_EVENT } from "../../lib/user-metadata-events";

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const payload = (await res.json()) as UsersResponse;
      setData(payload);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Live-refresh the list whenever any admin endpoint (role change, deactivate,
  // bulk-deactivate, hard-delete, etc.) reports it mutated user metadata —
  // including from the detail page or another tab. Avoids forcing the operator
  // to manually refresh after a role change to see the updated badge.
  useEffect(() => {
    const onChanged = () => {
      void refetch();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    window.addEventListener(USER_METADATA_CHANGED_EVENT, onChanged);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener(USER_METADATA_CHANGED_EVENT, onChanged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch]);

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

  const handleToggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const u of filtered) next.add(u.id);
      return next;
    });
  };

  const handleClearSelection = () => setSelected(new Set());

  const handleBulkDeactivate = async (deactivated: boolean) => {
    if (selected.size === 0) return;
    const verb = deactivated ? "deactivate" : "reactivate";
    if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${selected.size} user(s)?`)) {
      return;
    }
    setBulkBusy(true);
    try {
      const res = await fetch("/api/admin/users/bulk-deactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [...selected], deactivated }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      const result = (await res.json()) as BulkDeactivateResult;
      const failed = result.results.filter((r) => !r.success);
      if (failed.length > 0) {
        const lines = failed
          .slice(0, 10)
          .map((r) => `• ${r.userId}: ${r.error ?? "unknown"}`)
          .join("\n");
        alert(
          `${result.results.length - failed.length} succeeded · ${failed.length} failed:\n\n${lines}${
            failed.length > 10 ? "\n…" : ""
          }`,
        );
      } else {
        alert(`${result.results.length} user(s) ${verb}d.`);
      }
      // Notify other listeners (drawer admin gate, other open tabs/views)
      // that a batch of users just had their metadata flipped, so they can
      // refresh in place without a page reload.
      for (const id of [...selected]) {
        window.dispatchEvent(
          new CustomEvent(USER_METADATA_CHANGED_EVENT, {
            detail: { targetUserId: id },
          }),
        );
      }
      handleClearSelection();
      void refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Cost overview */}
      <CostOverviewCard />

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

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/60 dark:bg-rose-950/30">
          <span className="text-xs font-bold text-rose-700 dark:text-rose-300">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={handleClearSelection}
            disabled={bulkBusy}
            className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-white disabled:opacity-50 dark:border-slate-600 dark:text-slate-300"
          >
            Clear
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void handleBulkDeactivate(true)}
            disabled={bulkBusy}
            className="rounded-full bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
          >
            {bulkBusy ? "Working…" : "Bulk deactivate"}
          </button>
          <button
            type="button"
            onClick={() => void handleBulkDeactivate(false)}
            disabled={bulkBusy}
            className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            Bulk reactivate
          </button>
        </div>
      )}

      {/* User table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
              <tr>
                <th className="px-3 py-3 text-left">
                  <button
                    type="button"
                    onClick={handleSelectAllVisible}
                    className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-700"
                    title="Select all visible"
                  >
                    All
                  </button>
                </th>
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
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No users match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map((u) => (
                <tr key={u.id} className="transition hover:bg-slate-50 dark:hover:bg-slate-950/50">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => handleToggleSelect(u.id)}
                      className="h-4 w-4 cursor-pointer rounded border-slate-300"
                      aria-label={`Select ${displayName(u)}`}
                    />
                  </td>
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
                    <RoleBadge role={u.role} />
                    {u.deactivated && (
                      <span className="ml-1.5 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                        deactivated
                      </span>
                    )}
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

function CostOverviewCard() {
  const [data, setData] = useState<OrgCostOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/cost-overview", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as OrgCostOverview;
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

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900">
        Loading cost overview…
      </div>
    );
  }
  if (error || !data) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-rose-200 bg-rose-50/30 p-5 dark:border-rose-900/60 dark:bg-rose-950/20">
      <header className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
          Cost
        </span>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Org-wide token usage
        </h3>
      </header>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Total users" value={data.totalUsers.toLocaleString()} />
        <MiniStat label="Total tokens" value={data.totalTokens.toLocaleString()} />
        <MiniStat
          label="Estimated cost"
          value={`$${data.estimatedCostUsd.toFixed(4)}`}
        />
        <MiniStat
          label="Top spender"
          value={data.topSpenders[0]?.display ?? "—"}
          hint={
            data.topSpenders[0]
              ? `${data.topSpenders[0].totalTokens.toLocaleString()} tok`
              : ""
          }
        />
      </div>
      {data.topSpenders.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-rose-700 dark:text-rose-300">
            Top 10 spenders
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-700 dark:text-slate-200">
            {data.topSpenders.map((s) => (
              <li key={s.userId}>
                <span className="font-medium">{s.display}</span> —{" "}
                {s.totalTokens.toLocaleString()} tok ·{" "}
                ${s.estimatedCostUsd.toFixed(4)}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 dark:bg-slate-900">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className="mt-0.5 truncate text-base font-bold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      {hint && <p className="text-[10px] text-slate-400">{hint}</p>}
    </div>
  );
}

function RoleBadge({ role }: { role: import("@repo/admin/types").UserRole }) {
  const cls =
    role === "admin"
      ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {role}
    </span>
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
