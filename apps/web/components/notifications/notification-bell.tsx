"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AppNotification {
  _id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  reminderId?: string;
  read: boolean;
  createdAt: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeIcon(type: string) {
  if (type === "due_reminder") return "⏰";
  if (type === "pre_due_reminder") return "🔔";
  if (type === "overdue_nudge") return "⚠️";
  if (type === "morning_briefing") return "☀️";
  if (type === "share_invite" || type === "share_accepted") return "🤝";
  if (type === "admin_broadcast") return "📣";
  if (type === "smart_nudge") return "🤖";
  return "📌";
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Bell button icon ──────────────────────────────────────────────────────────

function BellIcon({ hasBadge }: { hasBadge: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      {hasBadge ? (
        <>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          <circle cx="18" cy="5" r="3" fill="#f43f5e" stroke="none" />
        </>
      ) : (
        <>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </>
      )}
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface NotificationBellProps {
  /** Poll interval for fetching new notifications (ms). Default 30 000. */
  pollIntervalMs?: number;
}

export function NotificationBell({ pollIntervalMs = 30_000 }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=30");
      if (!res.ok) return;
      const data = (await res.json()) as { notifications: AppNotification[]; unreadCount: number };
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      // network error — silently ignore
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    void fetchNotifications();
    const id = setInterval(() => void fetchNotifications(), pollIntervalMs);
    return () => clearInterval(id);
  }, [fetchNotifications, pollIntervalMs]);

  // Update tab title badge
  useEffect(() => {
    const base = "RemindOS";
    document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
  }, [unreadCount]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const markAllRead = async () => {
    setLoading(true);
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAll: true }),
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } finally {
      setLoading(false);
    }
  };

  const markOneRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n._id === id ? { ...n, read: true } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  };

  const handleBellClick = () => {
    setOpen((o) => !o);
    if (!open) void fetchNotifications();
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={handleBellClick}
        className="relative flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread notifications`
            : "Notifications"
        }
      >
        <BellIcon hasBadge={unreadCount > 0} />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[10px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:w-[340px] dark:border-slate-700 dark:bg-slate-900">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900/40">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#7c3aed"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3.5 w-3.5"
                >
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Notifications
              </span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                disabled={loading}
                className="text-xs font-medium text-violet-600 transition hover:text-violet-500 disabled:opacity-50 dark:text-violet-400"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <ul className="max-h-[400px] divide-y divide-slate-50 overflow-y-auto dark:divide-slate-800/60">
            {notifications.length === 0 && (
              <li className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5 text-slate-400"
                  >
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </div>
                <p className="text-sm text-slate-400">No notifications yet</p>
              </li>
            )}
            {notifications.map((n) => (
              <li
                key={n._id}
                className={`flex cursor-default gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                  !n.read ? "bg-violet-50/40 dark:bg-violet-950/20" : ""
                }`}
                onClick={() => {
                  if (!n.read) void markOneRead(n._id);
                }}
              >
                {/* Icon bubble */}
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm leading-none dark:bg-slate-800">
                  {typeIcon(n.type)}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className={`text-sm leading-snug ${
                        n.read
                          ? "font-normal text-slate-600 dark:text-slate-400"
                          : "font-semibold text-slate-900 dark:text-slate-100"
                      }`}
                    >
                      {n.title}
                    </p>
                    <span className="shrink-0 text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
                      {timeAgo(n.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-500">
                    {n.body}
                  </p>
                </div>

                {/* Unread dot */}
                {!n.read && (
                  <span className="mt-1.5 h-2 w-2 shrink-0 self-start rounded-full bg-rose-500" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
