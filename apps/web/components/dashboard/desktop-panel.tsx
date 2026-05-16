"use client";

/**
 * DesktopPanel
 *
 * Left sidebar + inline reminders panel — desktop only (lg:flex / hidden on mobile).
 * Extracted from dashboard-workspace.tsx.
 */

import { useState } from "react";
import type { ReminderItem } from "@repo/reminder";
import type { ReminderListTab, ShareInboxRow } from "./dashboard-types";
import type { GroupedReminders, SnapshotCounts } from "./reminder-list-overlay";
import {
  groupShareInboxRows,
  formatDisplayDateTime,
  matchesReminder,
} from "./dashboard-utils";
import { NotificationBell } from "../notifications/notification-bell";

export interface DesktopPanelProps {
  reminders: ReminderItem[];
  grouped: GroupedReminders;
  snapshot: SnapshotCounts;
  shareInbox: ShareInboxRow[];
  activeTab: ReminderListTab;
  onTabChange: (tab: ReminderListTab) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  isHistoryLoaded: boolean;
  briefingStreaming: boolean;
  isLoading: boolean;
  onNewReminder: () => void;
  onAllTasks: () => void;
  onRunBriefing: () => void;
  onMarkDone: (id: string) => void;
  onEdit: (reminder: ReminderItem) => void;
  onShare: (ids: string[]) => void;
  onAcceptShare: (batchKey: string) => void;
  onDenyShare: (batchKey: string) => void;
}

export function DesktopPanel({
  reminders,
  grouped,
  snapshot,
  shareInbox,
  activeTab,
  onTabChange,
  searchQuery,
  onSearchChange,
  isHistoryLoaded,
  briefingStreaming,
  isLoading,
  onNewReminder,
  onAllTasks,
  onRunBriefing,
  onMarkDone,
  onEdit,
  onShare,
  onAcceptShare,
  onDenyShare,
}: DesktopPanelProps) {
  return (
    <>
      {/* LEFT SIDEBAR */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        {/* Date */}
        <div className="border-b border-slate-100 px-4 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Today</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-700">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>
        {/* New Reminder button */}
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={onNewReminder}
            className="flex w-full items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500"
          >
            <span className="text-lg leading-none">+</span>
            New Reminder
          </button>
        </div>
        {/* Reminders section */}
        <div className="px-2 pb-2">
          <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Reminders</p>
          {(
            [
              { key: "all" as ReminderListTab, label: "All", count: reminders.length, dot: "#64748b" },
              { key: "missed" as ReminderListTab, label: "Missed", count: snapshot.missed, dot: "#f43f5e" },
              { key: "today" as ReminderListTab, label: "Today", count: snapshot.today, dot: "#f59e0b" },
              { key: "tomorrow" as ReminderListTab, label: "Tomorrow", count: snapshot.tomorrow, dot: "#7c3aed" },
              { key: "upcoming" as ReminderListTab, label: "Later", count: grouped.upcoming.length, dot: "#06b6d4" },
              { key: "done" as ReminderListTab, label: "Done", count: snapshot.done ?? 0, dot: "#10b981" },
            ] as { key: ReminderListTab; label: string; count: number; dot: string }[]
          ).map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => onTabChange(b.key)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                activeTab === b.key
                  ? "bg-violet-50 text-violet-700"
                  : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: b.dot }} />
              <span className="flex-1 text-sm font-medium">{b.label}</span>
              {b.count > 0 && (
                <span className={`text-xs font-semibold ${activeTab === b.key ? "text-violet-600" : "text-slate-400"}`}>
                  {b.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mx-3 h-px bg-slate-100" />
        {/* Tasks section */}
        <div className="px-2 py-2">
          <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tasks</p>
          <button
            type="button"
            onClick={onAllTasks}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-700 transition hover:bg-slate-50"
          >
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-indigo-500" />
            <span className="flex-1 text-sm font-medium">Upcoming</span>
          </button>
          <button
            type="button"
            onClick={onAllTasks}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-700 transition hover:bg-slate-50"
          >
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
            <span className="flex-1 text-sm font-medium">Done</span>
          </button>
        </div>
        <div className="mx-3 h-px bg-slate-100" />
        {/* Shared */}
        <div className="px-2 py-2">
          <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Collaboration</p>
          <button
            type="button"
            onClick={() => onTabChange("shared")}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-700 transition hover:bg-slate-50"
          >
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-cyan-500" />
            <span className="flex-1 text-sm font-medium">Shared with me</span>
            {shareInbox.length > 0 && (
              <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                {shareInbox.length}
              </span>
            )}
          </button>
        </div>
        <div className="flex-1" />
        {/* Bottom actions */}
        <div className="border-t border-slate-100 px-2 py-2">
          <button
            type="button"
            onClick={onRunBriefing}
            disabled={!isHistoryLoaded || briefingStreaming || isLoading}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <span className="text-sm">✦</span>
            <span className="text-sm font-medium">Run Briefing</span>
          </button>
          <div className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2">
            <NotificationBell pollIntervalMs={30_000} />
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT — desktop only inline reminders */}
      <div className="hidden min-h-0 flex-1 flex-col bg-[#fafaf9] lg:flex">
        {/* Panel header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
          <h2 className="flex-1 text-base font-bold text-slate-900">Reminders</h2>
          <button
            type="button"
            onClick={onNewReminder}
            className="rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
          >
            + New Reminder
          </button>
          <button
            type="button"
            onClick={onAllTasks}
            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            + Task
          </button>
        </div>
        {/* Bucket tabs */}
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2.5 scrollbar-none">
          {(
            [
              { key: "all", label: "All", count: reminders.length, activeClass: "bg-slate-700 text-white", inactiveClass: "bg-slate-100 text-slate-700 border border-slate-200" },
              { key: "missed", label: "Missed", count: snapshot.missed, activeClass: "bg-rose-600 text-white", inactiveClass: "bg-rose-50 text-rose-700 border border-rose-200" },
              { key: "today", label: "Today", count: snapshot.today, activeClass: "bg-amber-500 text-white", inactiveClass: "bg-amber-50 text-amber-700 border border-amber-200" },
              { key: "tomorrow", label: "Tomorrow", count: snapshot.tomorrow, activeClass: "bg-violet-600 text-white", inactiveClass: "bg-violet-50 text-violet-700 border border-violet-200" },
              { key: "upcoming", label: "Later", count: grouped.upcoming.length, activeClass: "bg-cyan-600 text-white", inactiveClass: "bg-cyan-50 text-cyan-700 border border-cyan-200" },
              { key: "shared", label: "Shared", count: shareInbox.length, activeClass: "bg-cyan-600 text-white", inactiveClass: "bg-slate-100 text-slate-600 border border-slate-200" },
              { key: "done", label: "Done", count: snapshot.done ?? 0, activeClass: "bg-emerald-600 text-white", inactiveClass: "bg-slate-100 text-slate-600 border border-slate-200" },
            ] as { key: ReminderListTab; label: string; count: number; activeClass: string; inactiveClass: string }[]
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
                activeTab === tab.key ? tab.activeClass : tab.inactiveClass
              }`}
            >
              {tab.label}{tab.count > 0 ? ` (${tab.count})` : ""}
            </button>
          ))}
        </div>
        {/* Desktop search bar */}
        {activeTab !== "shared" && (
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-4 py-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search reminders…"
                className="flex-1 bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400"
              />
              {searchQuery && (
                <button type="button" onClick={() => onSearchChange("")} className="text-slate-400 hover:text-slate-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-3 w-3"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              )}
            </div>
          </div>
        )}
        {/* Missed banner */}
        {snapshot.missed > 0 && (
          <div className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5">
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            <span className="flex-1 text-xs font-semibold text-rose-800">
              {snapshot.missed} overdue reminder{snapshot.missed > 1 ? "s" : ""} need attention
            </span>
            <button
              type="button"
              onClick={() => onTabChange("missed")}
              className="rounded-full bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-rose-500"
            >
              View
            </button>
          </div>
        )}
        {/* Reminders list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-none">
          <div className="grid gap-3">
            {(() => {
              const rawRows =
                activeTab === "shared" ? grouped.missed
                : activeTab === "done" ? grouped.done
                : activeTab === "upcoming" ? grouped.upcoming
                : activeTab === "missed" ? grouped.missed
                : activeTab === "today" ? grouped.today
                : activeTab === "tomorrow" ? grouped.tomorrow
                : reminders;
              const rows =
                activeTab === "shared"
                  ? rawRows
                  : rawRows.filter((r) => matchesReminder(r, searchQuery));

              if (activeTab === "shared") {
                return shareInbox.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-400">No shared reminders.</p>
                ) : (
                  groupShareInboxRows(shareInbox).map(({ batchKey, rows: bRows }) => {
                    const first = bRows[0]!;
                    const n = bRows.length;
                    return (
                      <div key={batchKey} className="rounded-xl border border-violet-200 bg-white px-4 py-3 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900">
                              {first.fromDisplayName}
                              {n > 1 ? ` · ${n} reminders` : ` · ${first.title}`}
                            </p>
                          </div>
                          <span className="flex shrink-0 gap-1">
                            <button
                              type="button"
                              className="rounded-full bg-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white"
                              onClick={() => onAcceptShare(batchKey)}
                            >
                              Accept all
                            </button>
                            <button
                              type="button"
                              className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-semibold text-slate-700"
                              onClick={() => onDenyShare(batchKey)}
                            >
                              Deny
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })
                );
              }

              if (rows.length === 0) {
                return <p className="py-8 text-center text-sm text-slate-400">Nothing here yet.</p>;
              }

              return rows.map((reminder) => (
                <article
                  key={reminder.id}
                  className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${
                    activeTab === "missed" ? "border-l-[3px] border-l-rose-500"
                    : activeTab === "today" ? "border-l-[3px] border-l-amber-500"
                    : activeTab === "tomorrow" ? "border-l-[3px] border-l-violet-500"
                    : activeTab === "done" ? "border-l-[3px] border-l-emerald-500"
                    : "border-l-[3px] border-l-cyan-500"
                  }`}
                >
                  <div className="p-3">
                    <p className="font-semibold text-slate-900">{reminder.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">Due: {formatDisplayDateTime(reminder.dueAt)}</p>
                    {reminder.notes ? (
                      <p className="mt-1 text-xs text-slate-600">{reminder.notes}</p>
                    ) : null}
                    {reminder.status !== "done" && reminder.status !== "archived" ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => onMarkDone(reminder.id)}
                          className="rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white"
                        >
                          Done
                        </button>
                        <button
                          type="button"
                          onClick={() => onEdit(reminder)}
                          className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-700"
                        >
                          Edit
                        </button>
                        {reminder.access !== "shared" ? (
                          <button
                            type="button"
                            onClick={() => onShare([reminder.id])}
                            className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700"
                          >
                            Share
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              ));
            })()}
          </div>
        </div>
      </div>
    </>
  );
}
