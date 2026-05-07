"use client";

import { useEffect, useState } from "react";
import type {
  AdminUserActivity,
  UserRole,
} from "@repo/admin/types";

interface DetailResponse {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    username: string;
    imageUrl: string;
    role: UserRole;
    createdAt: number;
    lastSignInAt: number | null;
  };
  activity: AdminUserActivity;
}

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

export function AdminUserDetailClient({ userId }: { userId: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/admin/users/${encodeURIComponent(userId)}/activity`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as DetailResponse;
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
  }, [userId]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Loading user activity…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-300 bg-rose-50 p-6 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
        <p className="font-semibold">Could not load activity</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { user, activity } = data;
  const fullName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.username ||
    user.email ||
    user.id;

  // Histogram normalisation
  const peak = Math.max(1, ...activity.dailyPromptCounts.map((d) => d.count));

  return (
    <div className="space-y-5">
      {/* User header */}
      <header className="flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {user.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.imageUrl}
            alt=""
            className="h-14 w-14 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-violet-100 text-lg font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
            {(fullName[0] ?? "?").toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-bold text-slate-900 dark:text-slate-100">
              {fullName}
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                user.role === "admin"
                  ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              {user.role}
            </span>
          </div>
          {user.email && (
            <p className="truncate text-sm text-slate-500 dark:text-slate-400">
              {user.email}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            Joined {formatDateTime(user.createdAt)} · Last sign-in{" "}
            {formatDateTime(user.lastSignInAt)}
          </p>
        </div>
      </header>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total prompts" value={activity.totalPrompts} />
        <StatCard label="Prompts (24h)" value={activity.promptsLast24h} />
        <StatCard label="Prompts (7d)" value={activity.promptsLast7d} />
        <StatCard
          label="Reminders"
          value={`${activity.remindersCompleted} / ${activity.remindersCreated}`}
          hint="completed / total"
        />
        <StatCard
          label="Tasks"
          value={`${activity.tasksCompleted} / ${activity.tasksCreated}`}
          hint="completed / total"
        />
      </div>

      {/* Daily activity histogram */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-3 text-sm font-bold text-slate-900 dark:text-slate-100">
          Daily prompt activity (last 14 days)
        </h3>
        <div className="flex h-32 items-end gap-1.5">
          {activity.dailyPromptCounts.map((d) => (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-24 w-full items-end">
                <div
                  className="w-full rounded-t bg-violet-500/80 transition-all"
                  style={{ height: `${(d.count / peak) * 100}%`, minHeight: d.count > 0 ? "4px" : "0" }}
                  title={`${d.date}: ${d.count} prompts`}
                />
              </div>
              <span className="text-[9px] tabular-nums text-slate-400">
                {d.date.slice(5)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Recent prompts */}
      <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Recent messages
          </h3>
          <span className="text-xs text-slate-400">
            {activity.recentPrompts.length} shown · previews truncated
          </span>
        </header>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {activity.recentPrompts.length === 0 && (
            <li className="px-5 py-6 text-center text-sm text-slate-400">
              No chat messages.
            </li>
          )}
          {activity.recentPrompts.map((row) => (
            <li
              key={row.clientId}
              className="grid gap-1 px-5 py-3 sm:grid-cols-[7rem_5rem_1fr] sm:gap-3"
            >
              <span className="text-xs text-slate-400">
                {formatDateTime(row.createdAt)}
              </span>
              <span
                className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  row.role === "user"
                    ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300"
                    : row.role === "assistant"
                    ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                {row.role}
              </span>
              <p className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
                {row.contentPreview}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>
      )}
    </div>
  );
}
