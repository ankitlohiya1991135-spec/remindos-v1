"use client";

/**
 * BottomNav
 *
 * Mobile-only fixed bottom navigation bar (hidden at lg+).
 * Four tabs: Chat · Reminders · Tasks · More
 *
 * Extracted from dashboard-workspace.tsx.
 */

import type { ReactNode } from "react";
import type { ReminderListTab } from "./dashboard-workspace";

export interface BottomNavProps {
  /** Which panels are currently open — used to derive active state */
  isListOpen: boolean;
  isTasksOpen: boolean;
  /** Number of missed/overdue reminders — shown as badge on Reminders tab */
  missedCount: number;
  /** Open the reminder list pre-filtered to the given tab */
  onOpenReminders: (tab: ReminderListTab) => void;
  onOpenTasks: () => void;
  onOpenMore: () => void;
}

interface NavItem {
  label: string;
  active: boolean;
  badge: number;
  onClick: (() => void) | undefined;
  icon: (active: boolean) => ReactNode;
}

export function BottomNav({
  isListOpen,
  isTasksOpen,
  missedCount,
  onOpenReminders,
  onOpenTasks,
  onOpenMore,
}: BottomNavProps) {
  const items: NavItem[] = [
    {
      label: "Chat",
      active: !isListOpen && !isTasksOpen,
      badge: 0,
      onClick: undefined,
      icon: (active) => (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path
            d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
            fill={active ? "rgba(139,92,246,0.2)" : "none"}
          />
        </svg>
      ),
    },
    {
      label: "Reminders",
      active: isListOpen,
      badge: missedCount,
      onClick: () => onOpenReminders(missedCount > 0 ? "missed" : "all"),
      icon: () => (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
    },
    {
      label: "Tasks",
      active: isTasksOpen,
      badge: 0,
      onClick: onOpenTasks,
      icon: () => (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      ),
    },
    {
      label: "More",
      active: false,
      badge: 0,
      onClick: onOpenMore,
      icon: () => (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      ),
    },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[rgba(255,255,255,0.07)] bg-[#1a1625] lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          className={`relative flex flex-1 flex-col items-center gap-0.5 pb-2 pt-2.5 text-[10px] font-semibold transition ${
            item.active ? "text-violet-400" : "text-[rgba(255,255,255,0.38)]"
          }`}
        >
          {/* Active indicator bar */}
          {item.active && (
            <span className="absolute inset-x-4 top-0 h-[2px] rounded-full bg-violet-500" />
          )}
          {item.icon(item.active)}
          <span>{item.label}</span>
          {item.badge > 0 && (
            <span className="absolute right-3 top-1.5 min-w-[15px] rounded-full bg-rose-500 px-1 py-0.5 text-[8px] font-bold leading-none text-white">
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
