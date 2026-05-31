"use client";

import { useCallback, useEffect, useState } from "react";
import { USER_ROLES, type UserRole } from "@repo/admin/types";
import type { AdminUserActivity } from "@repo/admin/types";
import { AdminNotesPanel } from "./admin-notes-panel";
import { AdminDmPanel } from "./admin-dm-panel";
import { broadcastUserMetadataChanged } from "../../lib/user-metadata-events";

interface DetailUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  imageUrl: string;
  role: UserRole;
  deactivated: boolean;
  createdAt: number;
  lastSignInAt: number | null;
}

interface DetailResponse {
  user: DetailUser;
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

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return "0m";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `${d}d` : `${d}d ${remH}h`;
}

export function AdminUserDetailClient({ userId }: { userId: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/activity`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const payload = (await res.json()) as DetailResponse;
      setData(payload);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refetch();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refetch]);

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
  const peak = Math.max(1, ...(activity.dailyPromptCounts ?? []).map((d) => d.count));

  // sessionStats may be missing if the Convex backend hasn't been redeployed
  // since the schema change. Fall back to zeros so the page still renders.
  const sessionStats = activity.sessionStats ?? {
    totalActiveMs: 0,
    activeMs24h: 0,
    activeMs7d: 0,
    sessionCount: 0,
    lastSeenAt: null,
  };
  const dailyPromptCounts = activity.dailyPromptCounts ?? [];
  const recentPrompts = activity.recentPrompts ?? [];
  const tokenEstimate = activity.tokenEstimate ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };

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
          {user.deactivated && (
            <span className="mt-2 inline-block rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
              Deactivated
            </span>
          )}
        </div>
      </header>

      {/* Admin actions panel — always visible to admins. Server re-verifies on every action. */}
      <AdminActionsPanel
        userId={user.id}
        role={user.role}
        deactivated={user.deactivated}
        onChanged={() => void refetch()}
      />

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
        <StatCard
          label="Active time (7d)"
          value={formatDuration(sessionStats.activeMs7d)}
          hint={`${sessionStats.sessionCount} sessions total`}
        />
        <StatCard
          label="Active time (24h)"
          value={formatDuration(sessionStats.activeMs24h)}
          hint={`last seen ${formatDateTime(sessionStats.lastSeenAt)}`}
        />
        <StatCard
          label="Active time (lifetime)"
          value={formatDuration(sessionStats.totalActiveMs)}
          hint="aggregate across all sessions"
        />
        <StatCard
          label="Tokens (msgs only)"
          value={tokenEstimate.totalTokens.toLocaleString()}
          hint={`${tokenEstimate.inputTokens.toLocaleString()} in · ${tokenEstimate.outputTokens.toLocaleString()} out`}
        />
        <StatCard
          label="Est. cost (USD)"
          value={`$${tokenEstimate.estimatedCostUsd.toFixed(4)}`}
          hint="lower bound — see details"
        />
      </div>

      <p className="text-[11px] text-slate-400">
        Token estimates count chat message text only. Real upstream usage is higher because each turn also includes wiki + digest context.
      </p>

      {/* Direct message + internal notes */}
      <div className="grid gap-4 lg:grid-cols-2">
        <AdminDmPanel userId={user.id} />
        <AdminNotesPanel userId={user.id} />
      </div>

      {/* Daily activity histogram */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-3 text-sm font-bold text-slate-900 dark:text-slate-100">
          Daily prompt activity (last 14 days)
        </h3>
        <div className="flex h-32 items-end gap-1.5">
          {dailyPromptCounts.map((d) => (
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
            {recentPrompts.length} shown · previews truncated
          </span>
        </header>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {recentPrompts.length === 0 && (
            <li className="px-5 py-6 text-center text-sm text-slate-400">
              No chat messages.
            </li>
          )}
          {recentPrompts.map((row) => (
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

      {/* Recent reminders */}
      {activity.recentReminders && (
        <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Recent reminders
            </h3>
            <span className="text-xs text-slate-400">
              {activity.recentReminders.length} shown
            </span>
          </header>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {activity.recentReminders.length === 0 && (
              <li className="px-5 py-6 text-center text-sm text-slate-400">
                No reminders.
              </li>
            )}
            {activity.recentReminders.map((row) => (
              <li
                key={row.id}
                className="grid gap-1 px-5 py-3 sm:grid-cols-[8rem_4rem_1fr_8rem] sm:gap-3"
              >
                <span className="text-xs text-slate-400">
                  {formatDateTime(row.createdAt)}
                </span>
                <span
                  className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    row.status === "done"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : row.status === "pending"
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {row.status}
                </span>
                <p className="truncate text-sm text-slate-700 dark:text-slate-200">
                  {row.title}
                </p>
                <span className="text-xs text-slate-400">
                  due {formatDateTime(row.dueAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent notifications */}
      {activity.recentNotifications && (
        <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Recent notifications
            </h3>
            <span className="text-xs text-slate-400">
              {activity.recentNotifications.length} shown
            </span>
          </header>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {activity.recentNotifications.length === 0 && (
              <li className="px-5 py-6 text-center text-sm text-slate-400">
                No notifications.
              </li>
            )}
            {activity.recentNotifications.map((row) => (
              <li
                key={row.id}
                className="grid gap-1 px-5 py-3 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-3"
              >
                <span className="text-xs text-slate-400">
                  {formatDateTime(row.createdAt)}
                </span>
                <span className="w-fit whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {row.type}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {row.title}
                    {!row.read && (
                      <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-rose-500" />
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {row.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AdminActionsPanel({
  userId,
  role,
  deactivated,
  onChanged,
}: {
  userId: string;
  role: UserRole;
  deactivated: boolean;
  onChanged: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingUserType, setPendingUserType] = useState<UserRole>(role);

  // Re-sync local form state whenever the parent feeds in fresh server data.
  useEffect(() => {
    setPendingUserType(role);
  }, [role]);

  const callApi = useCallback(
    async (path: string, body: unknown) => {
      setWorking(true);
      setActionError(null);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(payload.error ?? `Request failed (${res.status})`);
        }
        broadcastUserMetadataChanged(userId);
        onChanged();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setWorking(false);
      }
    },
    [onChanged, userId],
  );

  const handleSaveRole = () => {
    if (pendingUserType === role) return;
    void callApi(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
      userType: pendingUserType,
    });
  };

  const handleToggleDeactivate = () => {
    if (
      !confirm(
        deactivated
          ? "Reactivate this account? They'll be able to sign in again."
          : "Deactivate this account? They'll be banned from signing in.",
      )
    ) {
      return;
    }
    void callApi(`/api/admin/users/${encodeURIComponent(userId)}/deactivate`, {
      deactivated: !deactivated,
    });
  };

  return (
    <section className="rounded-2xl border border-rose-200 bg-rose-50/40 p-5 dark:border-rose-900/60 dark:bg-rose-950/20">
      <header className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
          Admin
        </span>
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Manage this user
        </h3>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Role (controls access)
          </label>
          <select
            value={pendingUserType}
            onChange={(e) => setPendingUserType(e.target.value as UserRole)}
            disabled={working}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSaveRole}
          disabled={working}
          className="rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
        >
          {working ? "Saving…" : "Save role changes"}
        </button>
        <button
          type="button"
          onClick={handleToggleDeactivate}
          disabled={working}
          className={`rounded-full px-4 py-2 text-xs font-semibold transition disabled:opacity-50 ${
            deactivated
              ? "bg-emerald-600 text-white hover:bg-emerald-500"
              : "bg-rose-600 text-white hover:bg-rose-500"
          }`}
        >
          {deactivated ? "Reactivate account" : "Deactivate account"}
        </button>
      </div>

      {/* Destructive actions */}
      <div className="mt-5 border-t border-rose-300/50 pt-4 dark:border-rose-900/40">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-rose-700 dark:text-rose-300">
          Destructive actions
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (
                !confirm(
                  "Reset this user's chat history? All their stored prompts will be permanently deleted from the database.",
                )
              ) return;
              void callApi(
                `/api/admin/users/${encodeURIComponent(userId)}/reset-chat`,
                {},
              );
            }}
            disabled={working}
            className="rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
          >
            Reset chat history
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                !confirm(
                  "Revoke ALL active sessions? The user will be signed out from every device immediately.",
                )
              ) return;
              void callApi(
                `/api/admin/users/${encodeURIComponent(userId)}/sessions/revoke`,
                {},
              );
            }}
            disabled={working}
            className="rounded-full border border-orange-300 bg-orange-50 px-4 py-2 text-xs font-semibold text-orange-800 transition hover:bg-orange-100 disabled:opacity-50 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300"
          >
            Revoke all sessions
          </button>
          <HardDeleteButton userId={userId} disabled={working} onChanged={onChanged} />
        </div>
      </div>

      {actionError && (
        <p className="mt-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
          {actionError}
        </p>
      )}
    </section>
  );
}

/**
 * Hard-delete is destructive and irreversible. Shows a modal that requires
 * the operator to type the user's email AND the literal word "DELETE".
 */
function HardDeleteButton({
  userId,
  disabled,
  onChanged,
}: {
  userId: string;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setWorking(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/hard-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmEmail, confirmPhrase }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      setOpen(false);
      setConfirmEmail("");
      setConfirmPhrase("");
      broadcastUserMetadataChanged(userId);
      onChanged();
      window.location.href = "/admin";
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="rounded-full bg-rose-700 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-600 disabled:opacity-50"
      >
        Hard-delete account
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-rose-300 bg-white p-5 shadow-2xl dark:border-rose-900 dark:bg-slate-900">
            <h3 className="text-base font-bold text-rose-700 dark:text-rose-400">
              Permanently delete account
            </h3>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              This deletes the user from Clerk and purges every reminder, task,
              chat message, notification, and profile row associated with them.
              Audit log entries remain. <strong>This cannot be undone.</strong>
            </p>
            <label className="mt-4 block text-xs font-semibold text-slate-600 dark:text-slate-300">
              Type the user&apos;s email to confirm:
              <input
                type="text"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                placeholder="user@example.com"
              />
            </label>
            <label className="mt-3 block text-xs font-semibold text-slate-600 dark:text-slate-300">
              Type DELETE to confirm:
              <input
                type="text"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                placeholder="DELETE"
              />
            </label>
            {err && (
              <p className="mt-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
                {err}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={working}
                className="rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={working || confirmPhrase !== "DELETE" || confirmEmail.trim() === ""}
                className="rounded-full bg-rose-700 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-600 disabled:opacity-50"
              >
                {working ? "Deleting…" : "Permanently delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
