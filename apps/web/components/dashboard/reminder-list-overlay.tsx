"use client";

/**
 * ReminderListOverlay
 *
 * Full-screen / bottom-sheet overlay listing all reminders, with tabs,
 * search/filter, bulk selection, and share-inbox cards.
 * Manages its own tab, filter, search, and selection state internally.
 *
 * Extracted from dashboard-workspace.tsx.
 */

import { useCallback, useMemo, useState, type MutableRefObject } from "react";
import type { ReminderItem } from "@repo/reminder";
import { isAdhocReminder } from "@repo/reminder";
import type { TaskRow } from "./task-panels";
import type { ReminderListTab, ShareInboxRow } from "./dashboard-types";
import { groupShareInboxRows } from "./dashboard-utils";
import { ReminderCard } from "./reminder-card";

// ── Grouped reminders shape ───────────────────────────────────────────────
export interface GroupedReminders {
  missed: ReminderItem[];
  today: ReminderItem[];
  tomorrow: ReminderItem[];
  upcoming: ReminderItem[];
  done: ReminderItem[];
}

// ── Snapshot counts ───────────────────────────────────────────────────────
export interface SnapshotCounts {
  missed: number;
  today: number;
  tomorrow: number;
  pending: number;
  done?: number;
}

export interface ReminderListOverlayProps {
  initialTab?: ReminderListTab;
  /** True while reminders are being fetched on initial load — shows skeleton cards */
  isLoading?: boolean;
  reminders: ReminderItem[];
  grouped: GroupedReminders;
  snapshot: SnapshotCounts;
  nextTwoHoursReminders: ReminderItem[];
  tasks: TaskRow[];
  taskTitleById: Record<string, string | undefined>;
  shareInbox: ShareInboxRow[];
  reminderLongPressTimerRef: MutableRefObject<number | null>;
  onClose: () => void;
  onOpenCreate: () => void;
  onMarkDone: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (reminder: ReminderItem) => void;
  onShare: (ids: string[]) => void;
  onSnooze: (id: string, currentDueAt: string | number) => void;
  /** Phase 2B: reschedule a missed reminder to today / tomorrow */
  onRescheduleToday: (id: string) => void;
  onRescheduleTomorrow: (id: string) => void;
  /** Phase 2C: bulk overdue banner actions */
  onArchiveAllMissed: () => void;
  onRescheduleAllMissed: () => void;
  /** Phase 2D: restore a done reminder back to pending */
  onRestore: (id: string) => void;
  onAcceptShare: (batchKey: string) => void;
  onDenyShare: (batchKey: string) => void;
  onShowToast: (msg: string) => void;
}

export function ReminderListOverlay({
  initialTab = "all",
  isLoading = false,
  reminders,
  grouped,
  snapshot,
  nextTwoHoursReminders,
  tasks,
  taskTitleById,
  shareInbox,
  reminderLongPressTimerRef,
  onClose,
  onOpenCreate,
  onMarkDone,
  onDelete,
  onEdit,
  onShare,
  onSnooze,
  onRescheduleToday,
  onRescheduleTomorrow,
  onArchiveAllMissed,
  onRescheduleAllMissed,
  onRestore,
  onAcceptShare,
  onDenyShare,
  onShowToast,
}: ReminderListOverlayProps) {
  // ── Internal state ─────────────────────────────────────────────────────
  const [reminderListTab, setReminderListTab] = useState<ReminderListTab>(initialTab);
  const [reminderSearchQuery, setReminderSearchQuery] = useState("");
  const [reminderTaskFilter, setReminderTaskFilter] = useState<"all" | "adhoc" | string>("all");
  const [sharedFromFilter, setSharedFromFilter] = useState<"all" | string>("all");
  const [sentToFilter, setSentToFilter] = useState<"all" | string>("all");
  const [reminderSelectionMode, setReminderSelectionMode] = useState(false);
  const [selectedReminderIds, setSelectedReminderIds] = useState<Set<string>>(() => new Set());

  const toggleReminderSelect = useCallback((id: string) => {
    setSelectedReminderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Computed counts ───────────────────────────────────────────────────
  const sharedTabCount = useMemo(
    () => reminders.filter((r) => r.access === "shared").length,
    [reminders],
  );
  const sentTabCount = useMemo(
    () => reminders.filter((r) => r.access === "owner" && r.outgoingShared).length,
    [reminders],
  );

  // ── Filtered rows ─────────────────────────────────────────────────────
  const reminderListRows = useMemo(() => {
    // matchesReminder(reminder, targetId?, targetTitle?) is for finding a specific
    // reminder by ID or exact title — it returns false when both args are absent,
    // so it cannot double as a "show all when empty" search predicate.
    const q = reminderSearchQuery.trim().toLowerCase();
    const search = (r: ReminderItem) =>
      !q ||
      r.title.toLowerCase().includes(q) ||
      (r.notes?.toLowerCase().includes(q) ?? false);
    const filterTask = (rows: ReminderItem[]) => {
      if (reminderTaskFilter === "adhoc") return rows.filter((r) => isAdhocReminder(r));
      if (reminderTaskFilter !== "all") return rows.filter((r) => r.linkedTaskId === reminderTaskFilter);
      return rows;
    };

    if (reminderListTab === "all") return filterTask(reminders.filter(search));
    if (reminderListTab === "next2hours") return filterTask(nextTwoHoursReminders.filter(search));
    if (reminderListTab === "shared") {
      let rows = reminders.filter((r) => r.access === "shared");
      if (sharedFromFilter !== "all") rows = rows.filter((r) => r.ownerUserId === sharedFromFilter);
      return filterTask(rows.filter(search));
    }
    if (reminderListTab === "sent") {
      let rows = reminders.filter((r) => r.access === "owner" && r.outgoingShared);
      if (sentToFilter !== "all")
        rows = rows.filter((r) => r.shareRecipients?.some((p) => p.userId === sentToFilter));
      return filterTask(rows.filter(search));
    }
    const base = (grouped[reminderListTab] ?? []).filter(search);
    return filterTask(base);
  }, [
    grouped, reminderListTab, reminderTaskFilter, reminders, reminderSearchQuery,
    sharedFromFilter, sentToFilter, nextTwoHoursReminders,
  ]);

  // ── Long-press helpers ────────────────────────────────────────────────
  const handleLongPressStart = (reminder: ReminderItem) => {
    if (reminder.access === "shared" || reminder.status === "done" || reminder.status === "archived") return;
    reminderLongPressTimerRef.current = window.setTimeout(() => {
      reminderLongPressTimerRef.current = null;
      setReminderSelectionMode(true);
      toggleReminderSelect(reminder.id);
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(35);
    }, 450);
  };
  const handleLongPressEnd = useCallback(() => {
    const t = reminderLongPressTimerRef.current;
    if (t != null) { window.clearTimeout(t); reminderLongPressTimerRef.current = null; }
  }, [reminderLongPressTimerRef]);

  // ── JSX ───────────────────────────────────────────────────────────────
  return (
    <div
      data-testid="reminder-list-overlay"
      className="fixed inset-0 z-50 flex flex-col bg-[#fafaf9] sm:items-center sm:justify-center sm:bg-black/50 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-[#fafaf9] sm:h-auto sm:max-h-[min(92vh,760px)] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-slate-200 sm:shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ── Top bar ── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:pt-3">
          <button type="button" onClick={onClose} className="mr-1 sm:hidden">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-5 w-5 text-slate-500"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <h2 className="flex-1 text-[18px] font-extrabold text-slate-900">Reminders</h2>
          <button
            type="button"
            onClick={onOpenCreate}
            data-testid="reminder-create-button"
            className="flex items-center gap-1 rounded-full bg-violet-600 px-4 py-2 text-[13px] font-bold text-white shadow-sm transition hover:bg-violet-500"
          >
            <span className="text-base leading-none">+</span> New
          </button>
          <button type="button" className="hidden sm:block rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold" onClick={onClose} data-testid="reminder-list-close">Close</button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2.5 scrollbar-none">
          {(
            [
              ["all",       "All",      "#64748b", reminders.length],
              ["missed",    "Missed",   "#f43f5e", grouped.missed.length],
              ["today",     "Today",    "#f59e0b", grouped.today.length],
              ["tomorrow",  "Tmrw",     "#7c3aed", grouped.tomorrow.length],
              ["upcoming",  "Later",    "#06b6d4", grouped.upcoming.length],
              ["shared",    "Shared",   "#06b6d4", sharedTabCount],
              ["sent",      "Sent",     "#6366f1", sentTabCount],
              ["done",      "Done",     "#10b981", grouped.done.length],
            ] as const
          ).map(([key, label, dotColor, count]) => {
            const active = reminderListTab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setReminderListTab(key)}
                data-testid={`reminder-tab-${key}`}
                className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold transition ${
                  active ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {!active && <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: dotColor }} />}
                {label}
                {count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold leading-none ${
                    active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"
                  }`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Missed alert banner (Phase 2C: bulk actions) ── */}
        {reminderListTab === "missed" && snapshot.missed > 0 && (
          <div className="mx-3 mt-3 flex shrink-0 flex-col gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-rose-500 shrink-0" />
              <span className="flex-1 text-[12px] font-semibold text-rose-800">
                {snapshot.missed} reminder{snapshot.missed > 1 ? "s" : ""} need{snapshot.missed === 1 ? "s" : ""} immediate action
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4 text-rose-400"><path d="m9 18 6-6-6-6"/></svg>
            </div>
            {snapshot.missed > 1 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onArchiveAllMissed}
                  className="rounded-full border border-rose-300 bg-white px-3 py-1 text-[11px] font-bold text-rose-700 active:bg-rose-100"
                >
                  Archive all
                </button>
                <button
                  type="button"
                  onClick={onRescheduleAllMissed}
                  className="rounded-full border border-rose-300 bg-white px-3 py-1 text-[11px] font-bold text-rose-700 active:bg-rose-100"
                >
                  Reschedule to this week
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Search / filter bar ── */}
        {reminderListTab !== "shared" && reminderListTab !== "sent" && (
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-3 py-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input
                value={reminderSearchQuery}
                onChange={(e) => setReminderSearchQuery(e.target.value)}
                placeholder="Filter..."
                className="flex-1 bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400"
              />
            </div>
            <select
              value={reminderTaskFilter}
              onChange={(e) => setReminderTaskFilter(e.target.value as "all" | "adhoc" | string)}
              className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] text-slate-600 font-medium"
            >
              <option value="all">All types</option>
              <option value="adhoc">ADHOC only</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>Task: {t.title}</option>)}
            </select>
          </div>
        )}

        {/* ── Bulk selection bar ── */}
        {reminderListTab !== "shared" && reminderSelectionMode && (
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-4 py-2">
            <button
              type="button"
              className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700"
              data-testid="reminder-selection-cancel"
              onClick={() => { setReminderSelectionMode(false); setSelectedReminderIds(new Set()); }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selectedReminderIds.size === 0}
              data-testid="reminder-selection-share"
              className="rounded-full bg-violet-600 px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onShare([...selectedReminderIds])}
            >
              Share ({selectedReminderIds.size})
            </button>
          </div>
        )}

        {/* ── Shared tab: pending invites ── */}
        {reminderListTab === "shared" && shareInbox.length > 0 && (
          <div className="shrink-0 border-b border-violet-100 bg-violet-50/60 px-4 py-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-violet-700">Pending Invites</p>
            <div className="space-y-2">
              {groupShareInboxRows(shareInbox).map(({ batchKey, rows }) => {
                const first = rows[0]!;
                const n = rows.length;
                return (
                  <div key={batchKey} className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-white px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-slate-900">
                        {first.fromDisplayName}
                        {n > 1 ? ` · ${n} reminders` : ` · ${first.title}`}
                      </p>
                      {n > 1 && (
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">
                          {rows.map((r) => r.title).join(", ")}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        className="rounded-full bg-violet-600 px-3 py-1 text-[11px] font-bold text-white"
                        onClick={() => onAcceptShare(batchKey)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-bold text-slate-600"
                        onClick={() => onDenyShare(batchKey)}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Card list ── */}
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {/* Skeleton loader — shown while the initial fetch is in flight */}
          {isLoading ? (
            <div className="space-y-2 px-3 py-3" aria-busy="true" aria-label="Loading reminders">
              {[...Array(5)].map((_, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton — order never changes
                  key={i}
                  className="flex gap-3 rounded-2xl border border-slate-100 bg-white px-3.5 py-3 shadow-sm"
                >
                  {/* Left dot */}
                  <div className="flex shrink-0 flex-col items-center pt-1">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-slate-200" />
                  </div>
                  {/* Content lines */}
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-2/3 animate-pulse rounded-full bg-slate-200" />
                    <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-slate-100" />
                    <div className="mt-1 flex gap-1">
                      <div className="h-4 w-10 animate-pulse rounded-full bg-slate-100" />
                      <div className="h-4 w-14 animate-pulse rounded-full bg-slate-100" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : reminderListRows.length === 0 && !(reminderListTab === "shared" && shareInbox.length > 0) ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <span className="mb-3 text-4xl">{reminderListTab === "done" ? "✅" : reminderListTab === "missed" ? "🎉" : "🔔"}</span>
              <p className="text-[14px] font-semibold text-slate-700">
                {reminderListTab === "done" ? "No completed reminders yet" :
                 reminderListTab === "missed" ? "You're all caught up!" :
                 reminderListTab === "shared" ? "No joined reminders yet" :
                 "Nothing scheduled here"}
              </p>
              <p className="mt-1 text-[12px] text-slate-400">
                {reminderListTab === "missed" ? "Great job staying on top of things." : "Tap + New to add one."}
              </p>
            </div>
          ) : (
            <div className="space-y-0 px-3 py-3">
              {(() => {
                const makeCard = (reminder: ReminderItem) => (
                  <ReminderCard
                    key={reminder.id}
                    reminder={reminder}
                    tab={reminderListTab}
                    selectionMode={reminderSelectionMode}
                    selected={selectedReminderIds.has(reminder.id)}
                    taskTitleById={taskTitleById}
                    onSelect={toggleReminderSelect}
                    onLongPressStart={() => handleLongPressStart(reminder)}
                    onLongPressEnd={handleLongPressEnd}
                    onMarkDone={() => onMarkDone(reminder.id)}
                    onDelete={() => onDelete(reminder.id)}
                    onEdit={() => onEdit(reminder)}
                    onShare={() => onShare([reminder.id])}
                    onSnooze={() => onSnooze(reminder.id, reminder.dueAt)}
                    onRescheduleToday={reminderListTab === "missed" ? () => onRescheduleToday(reminder.id) : undefined}
                    onRescheduleTomorrow={reminderListTab === "missed" ? () => onRescheduleTomorrow(reminder.id) : undefined}
                    onRestore={reminderListTab === "done" ? () => onRestore(reminder.id) : undefined}
                  />
                );

                /* For "today" tab: group by MORNING / AFTERNOON / EVENING */
                if (reminderListTab === "today" && reminderListRows.length > 0) {
                  const periods: { label: string; color: string; items: ReminderItem[] }[] = [
                    { label: "MORNING", color: "#f59e0b", items: [] },
                    { label: "AFTERNOON", color: "#f59e0b", items: [] },
                    { label: "EVENING", color: "#f59e0b", items: [] },
                  ];
                  for (const r of reminderListRows) {
                    const h = new Date(r.dueAt).getHours();
                    if (h < 12) periods[0]!.items.push(r);
                    else if (h < 17) periods[1]!.items.push(r);
                    else periods[2]!.items.push(r);
                  }
                  return periods.filter((p) => p.items.length > 0).map((period) => (
                    <div key={period.label} className="mb-1">
                      <p className="mb-1.5 px-1 pt-2 text-[9px] font-extrabold uppercase tracking-widest" style={{ color: period.color }}>
                        {period.label}
                      </p>
                      <div className="space-y-2">{period.items.map(makeCard)}</div>
                    </div>
                  ));
                }

                /* For "done" tab: group by TODAY / YESTERDAY / EARLIER */
                if (reminderListTab === "done" && reminderListRows.length > 0) {
                  const now = new Date();
                  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
                  const startYesterday = new Date(startToday); startYesterday.setDate(startYesterday.getDate() - 1);
                  const groups: { label: string; items: ReminderItem[] }[] = [
                    { label: "TODAY", items: [] },
                    { label: "YESTERDAY", items: [] },
                    { label: "EARLIER", items: [] },
                  ];
                  for (const r of reminderListRows) {
                    const d = new Date(r.dueAt);
                    if (d >= startToday) groups[0]!.items.push(r);
                    else if (d >= startYesterday) groups[1]!.items.push(r);
                    else groups[2]!.items.push(r);
                  }
                  return groups.filter((g) => g.items.length > 0).map((group) => (
                    <div key={group.label} className="mb-1">
                      <p className="mb-1.5 px-1 pt-2 text-[9px] font-extrabold uppercase tracking-widest text-emerald-600">
                        {group.label}
                      </p>
                      <div className="space-y-2">{group.items.map(makeCard)}</div>
                    </div>
                  ));
                }

                /* Flat list for all other tabs */
                return reminderListRows.map(makeCard);
              })()}
            </div>
          )}

          {/* ── FAB new reminder ── */}
          <button
            type="button"
            onClick={onOpenCreate}
            data-testid="reminder-fab-button"
            className="fixed bottom-20 right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-violet-600 text-white shadow-lg shadow-violet-500/40 transition hover:bg-violet-500 active:scale-95 lg:hidden"
            aria-label="New reminder"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
