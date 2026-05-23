"use client";

import { useUser, useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { canAccessAdmin, getRoleFromPublicMetadata } from "@repo/admin";
import {
  USER_METADATA_CHANGED_EVENT,
  type UserMetadataChangedDetail,
} from "../../lib/user-metadata-events";
import {
  loadDueNotificationPrefs,
  saveDueNotificationPrefs,
  type DueNotificationPrefs,
} from "../../lib/reminder-notification-prefs";
import { NotificationPrefsPanel } from "../notifications/notification-prefs-panel";

const SUGGESTED_QUESTIONS_KEY = "remindos:showSuggestedQuestions";

export function AppDrawer() {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();

  // ── Snapshot counts — updated via custom event from the dashboard ─────────
  const [snapshot, setSnapshot] = useState({ missed: 0, today: 0, tomorrow: 0, pending: 0 });

  // ── Notification prefs — read/write localStorage directly ─────────────────
  const [dueNotifPrefs, setDueNotifPrefsState] = useState<DueNotificationPrefs>(
    () => loadDueNotificationPrefs(),
  );
  const [showSuggestedQuestions, setShowSuggestedQuestions] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return localStorage.getItem(SUGGESTED_QUESTIONS_KEY) !== "0"; } catch { return true; }
  });

  const updateNotifPrefs = (next: DueNotificationPrefs) => {
    setDueNotifPrefsState(next);
    saveDueNotificationPrefs(next);
  };

  const pushGranted = typeof Notification !== "undefined" && Notification.permission === "granted";
  const pushDenied  = typeof Notification !== "undefined" && Notification.permission === "denied";

  const open = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  };

  const close = () => {
    setVisible(false);
    closeTimerRef.current = setTimeout(() => setMounted(false), 300);
  };

  useEffect(() => {
    window.addEventListener("dashboard:open-drawer", open);
    return () => window.removeEventListener("dashboard:open-drawer", open);
  }, []);

  // Keep snapshot counts fresh — dashboard broadcasts this whenever its snapshot changes
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<typeof snapshot>).detail;
      if (detail) setSnapshot(detail);
    };
    window.addEventListener("dashboard:snapshot-update", handler);
    return () => window.removeEventListener("dashboard:snapshot-update", handler);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Reactively re-pull this user's Clerk metadata whenever:
  //   1. an admin endpoint anywhere in the app reports the metadata moved,
  //      AND the change is about THIS signed-in user (covers self-flip
  //      paths and admin-issued role changes for the current user);
  //   2. the tab regains visibility (covers the cross-tab case where a
  //      different admin demoted/promoted you while you were away).
  // Calling user.reload() refreshes publicMetadata in-place; the next
  // render of `isAdmin` below picks up the new value, so the
  // "User Management" link appears or disappears without a page refresh.
  useEffect(() => {
    if (!user) return;

    const handleMetadataChanged = (event: Event) => {
      const detail = (event as CustomEvent<UserMetadataChangedDetail>).detail;
      if (!detail) return;
      if (detail.targetUserId === user.id) {
        void user.reload();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void user.reload();
      }
    };

    window.addEventListener(USER_METADATA_CHANGED_EVENT, handleMetadataChanged);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener(USER_METADATA_CHANGED_EVENT, handleMetadataChanged);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [user]);

  if (!mounted) return null;

  const initial =
    user?.firstName?.[0]?.toUpperCase() ??
    user?.emailAddresses?.[0]?.emailAddress?.[0]?.toUpperCase() ??
    "U";
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "User";
  const email = user?.emailAddresses?.[0]?.emailAddress ?? "";

  // Type-safe admin check via @repo/admin (no `as` casts thanks to the
  // global UserPublicMetadata augmentation in that package). True for
  // the `admin` role. NOTE: This is UI-gating only — every admin API
  // route also re-verifies server-side, so a user can't see admin data
  // even if they spoof this.
  const isAdmin = canAccessAdmin(getRoleFromPublicMetadata(user?.publicMetadata));

  const dispatch = (eventName: string) => {
    close();
    setTimeout(() => window.dispatchEvent(new CustomEvent(eventName)), 150);
  };

  const navigateAndClose = (path: string) => {
    close();
    setTimeout(() => router.push(path), 150);
  };

  const quickActions = [
    {
      icon: "⏱",
      label: "Next 2 Hours",
      event: "dashboard:open-next-two-hours",
      color:
        "from-amber-500 to-orange-600 ring-1 ring-amber-400/25 shadow-amber-200/40",
      testId: "drawer-action-next-2-hours",
    },
    {
      icon: "+",
      label: "New Reminder",
      event: "dashboard:create-reminder",
      color:
        "from-violet-500 to-violet-700 ring-1 ring-violet-400/25 shadow-violet-200/40",
      testId: "drawer-action-new-reminder",
    },
    {
      icon: "☰",
      label: "All Reminders",
      event: "dashboard:open-reminders",
      color:
        "from-violet-500 to-violet-700 ring-1 ring-violet-400/25 shadow-violet-200/40",
      testId: "drawer-action-all-reminders",
    },
    {
      icon: "✓",
      label: "Create Task",
      event: "dashboard:create-task",
      color:
        "from-violet-500 to-violet-700 ring-1 ring-violet-400/25 shadow-violet-200/40",
      testId: "drawer-action-create-task",
    },
    {
      icon: "≣",
      label: "All Tasks",
      event: "dashboard:open-tasks",
      color:
        "from-teal-500 to-teal-700 ring-1 ring-teal-400/25 shadow-teal-200/40",
      testId: "drawer-action-all-tasks",
    },
    {
      icon: "✦",
      label: "Run Briefing",
      event: "dashboard:run-briefing",
      color:
        "from-cyan-500 to-cyan-700 ring-1 ring-cyan-400/25 shadow-cyan-200/40",
      testId: "drawer-action-run-briefing",
    },
  ];

  return (
    <div
      data-testid="app-drawer"
      className="fixed inset-0 z-50 flex"
      style={{ pointerEvents: visible ? "auto" : "none" }}
    >
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/50 transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
        onClick={close}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="flex w-[min(22rem,92vw)] flex-col overflow-hidden bg-white shadow-2xl transition-transform duration-300 dark:bg-slate-950"
        style={{ transform: visible ? "translateX(0)" : "translateX(100%)" }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))] dark:border-slate-800">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-violet-600 dark:text-violet-400">
            Workspace
          </span>
          <button
            type="button"
            onClick={close}
            data-testid="drawer-close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close menu"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
          {/* User card */}
          <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-cyan-50/50 px-4 py-3 dark:border-violet-900/40 dark:from-violet-950/30 dark:to-cyan-950/20">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#7c3aed,#06b6d4)] text-base font-bold text-white shadow-md">
                {initial}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {displayName}
                </p>
                {email ? (
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {email}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── Stats row (Missed / Today / Tomorrow / Later) ────────────── */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Missed", count: snapshot.missed, border: "border-rose-100 dark:border-rose-900/40", bg: "bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-950/50", text: "text-rose-600 dark:text-rose-400", sub: "text-rose-500/80 dark:text-rose-400/70", tab: "missed" },
              { label: "Today",  count: snapshot.today,  border: "border-amber-100 dark:border-amber-900/40", bg: "bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50", text: "text-amber-600 dark:text-amber-400", sub: "text-amber-500/80 dark:text-amber-400/70", tab: "today" },
              { label: "Tomorrow", count: snapshot.tomorrow, border: "border-sky-100 dark:border-sky-900/40", bg: "bg-sky-50 dark:bg-sky-950/30 hover:bg-sky-100 dark:hover:bg-sky-950/50", text: "text-sky-600 dark:text-sky-400", sub: "text-sky-500/80 dark:text-sky-400/70", tab: "tomorrow" },
              { label: "Later",  count: Math.max(0, snapshot.pending - snapshot.missed - snapshot.today - snapshot.tomorrow), border: "border-slate-200 dark:border-slate-700", bg: "bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800", text: "text-slate-700 dark:text-slate-300", sub: "text-slate-400", tab: "upcoming" },
            ].map((tile) => (
              <button
                key={tile.label}
                type="button"
                onClick={() => { dispatch(`dashboard:open-reminders`); }}
                className={`flex flex-col items-center justify-center rounded-xl border px-1 py-3 text-center transition active:scale-95 ${tile.border} ${tile.bg}`}
              >
                <span className={`text-2xl font-extrabold tabular-nums leading-none ${tile.text}`}>{tile.count}</span>
                <span className={`mt-0.5 text-[9px] font-bold uppercase tracking-widest ${tile.sub}`}>{tile.label}</span>
              </button>
            ))}
          </div>

          {/* Quick actions grid */}
          <p className="mb-2.5 mt-5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Quick Actions
          </p>
          <div className="grid grid-cols-2 gap-2">
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                data-testid={action.testId}
                onClick={() => dispatch(action.event)}
                className={`flex min-h-[3rem] flex-col items-center justify-center gap-0.5 rounded-xl bg-gradient-to-b px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] ${action.color}`}
              >
                <span className="text-sm leading-none opacity-90">{action.icon}</span>
                <span className="mt-0.5 leading-tight">{action.label}</span>
              </button>
            ))}
          </div>

          {/* Import / Export / Batch */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              { label: "Import", event: "dashboard:open-import", testId: "drawer-import" },
              { label: "Export", event: "dashboard:export-chat", testId: "drawer-export" },
              { label: "Batch", event: "dashboard:open-batch", testId: "drawer-batch" },
            ].map((btn) => (
              <button
                key={btn.label}
                type="button"
                data-testid={btn.testId}
                onClick={() => dispatch(btn.event)}
                className="flex min-h-[2.25rem] items-center justify-center rounded-xl border border-slate-200 bg-slate-50/90 text-xs font-semibold text-slate-700 transition hover:bg-white hover:shadow-sm active:scale-[0.97] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* ── Quick Settings ────────────────────────────────────────────── */}
          <p className="mb-1 mt-5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            Quick Settings
          </p>
          <div className="overflow-hidden rounded-2xl border border-slate-100 dark:border-slate-800">
            {/* Suggested questions */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Suggested questions</span>
              <div className="relative shrink-0">
                <input type="checkbox" className="sr-only" checked={showSuggestedQuestions}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setShowSuggestedQuestions(on);
                    try { localStorage.setItem(SUGGESTED_QUESTIONS_KEY, on ? "1" : "0"); } catch { /* ignore */ }
                    window.dispatchEvent(new CustomEvent("dashboard:suggested-questions-toggle", { detail: on }));
                  }} />
                <div className={`h-6 w-11 rounded-full transition-colors ${showSuggestedQuestions ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"}`} />
                <div className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${showSuggestedQuestions ? "translate-x-6" : "translate-x-1"}`} />
              </div>
            </label>
            {/* Push notifications */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Push notifications</span>
              <div className="relative shrink-0">
                <input type="checkbox" className="sr-only"
                  checked={dueNotifPrefs.enabled && pushGranted}
                  disabled={pushDenied}
                  onChange={(e) => {
                    if (e.target.checked) window.dispatchEvent(new CustomEvent("dashboard:request-notification-permission"));
                    else updateNotifPrefs({ ...dueNotifPrefs, enabled: false });
                  }} />
                <div className={`h-6 w-11 rounded-full transition-colors ${dueNotifPrefs.enabled && pushGranted ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"}`} />
                <div className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${dueNotifPrefs.enabled && pushGranted ? "translate-x-6" : "translate-x-1"}`} />
              </div>
            </label>
            {/* Morning briefing */}
            <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Morning briefing</span>
              <div className="relative shrink-0">
                <input type="checkbox" className="sr-only"
                  checked={dueNotifPrefs.morningBriefingEnabled}
                  onChange={(e) => updateNotifPrefs({ ...dueNotifPrefs, morningBriefingEnabled: e.target.checked })} />
                <div className={`h-6 w-11 rounded-full transition-colors ${dueNotifPrefs.morningBriefingEnabled ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"}`} />
                <div className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${dueNotifPrefs.morningBriefingEnabled ? "translate-x-6" : "translate-x-1"}`} />
              </div>
            </label>
            {/* Sound alerts */}
            <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Sound alerts</span>
              <div className="relative shrink-0">
                <input type="checkbox" className="sr-only"
                  checked={dueNotifPrefs.soundEnabled}
                  onChange={(e) => updateNotifPrefs({ ...dueNotifPrefs, soundEnabled: e.target.checked })} />
                <div className={`h-6 w-11 rounded-full transition-colors ${dueNotifPrefs.soundEnabled ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700"}`} />
                <div className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${dueNotifPrefs.soundEnabled ? "translate-x-6" : "translate-x-1"}`} />
              </div>
            </label>
          </div>

          {/* More notification options (full prefs panel) */}
          <details className="mt-2">
            <summary className="cursor-pointer rounded-xl border border-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-900">
              More notification options…
            </summary>
            <div className="mt-2">
              <NotificationPrefsPanel
                prefs={dueNotifPrefs}
                onChange={updateNotifPrefs}
                onRequestPermission={() => window.dispatchEvent(new CustomEvent("dashboard:request-notification-permission"))}
              />
            </div>
          </details>

          {/* Divider */}
          <div className="my-4 h-px bg-slate-100 dark:bg-slate-800" />

          {/* Admin: User Management — only rendered when role === "admin" */}
          {isAdmin && (
            <button
              type="button"
              onClick={() => navigateAndClose("/admin")}
              data-testid="drawer-user-management"
              className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 py-2.5 text-center text-xs font-semibold text-violet-700 transition hover:bg-violet-100 active:scale-[0.98] dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-950/60"
            >
              <span>👥</span>
              User Management
            </button>
          )}

          {/* Clear chat */}
          <button
            type="button"
            onClick={() => dispatch("dashboard:clear-chat")}
            data-testid="drawer-clear-chat"
            className="w-full rounded-xl border border-rose-200 bg-rose-50/80 py-2.5 text-center text-xs font-semibold text-rose-700 transition hover:bg-rose-100 active:scale-[0.98] dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-400 dark:hover:bg-rose-950/60"
          >
            Clear Chat History
          </button>

          {/* Sign out */}
          <button
            type="button"
            onClick={() => {
              close();
              setTimeout(() => void signOut(() => router.push("/")), 200);
            }}
            data-testid="drawer-sign-out"
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 py-2.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50 active:scale-[0.98] dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <span>🚪</span>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
