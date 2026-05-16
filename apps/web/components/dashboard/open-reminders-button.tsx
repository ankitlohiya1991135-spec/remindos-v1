"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type ReminderBadgeStatus = "pending" | "done" | "archived";

interface ReminderBadgeItem {
  id: string;
  dueAt: string;
  status: ReminderBadgeStatus;
}

interface ReminderChangeDetail {
  reminders?: ReminderBadgeItem[];
}

function toIsoDueAt(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function mapApiReminderItems(items: Array<Record<string, unknown>>): ReminderBadgeItem[] {
  return items.flatMap((item) => {
    const dueAt = toIsoDueAt(item.dueAt);
    if (!dueAt) return [];
    return [
      {
        id: String(item._id ?? item.id ?? `${dueAt}-${item.title ?? "reminder"}`),
        dueAt,
        status: item.status === "done" ? "done" : item.status === "archived" ? "archived" : "pending",
      },
    ];
  });
}

function countMissedReminders(items: ReminderBadgeItem[], nowMs: number) {
  const startToday = new Date(nowMs);
  startToday.setHours(0, 0, 0, 0);
  const startTodayMs = startToday.getTime();
  return items.filter((item) => {
    if (item.status !== "pending") return false;
    const dueMs = new Date(item.dueAt).getTime();
    return Number.isFinite(dueMs) && dueMs >= startTodayMs && dueMs < nowMs;
  }).length;
}

export function OpenRemindersButton() {
  const pathname = usePathname();
  const router = useRouter();
  const [reminders, setReminders] = useState<ReminderBadgeItem[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const response = await fetch("/api/reminders");
        if (!response.ok) return;
        const data = (await response.json()) as { reminders?: Array<Record<string, unknown>> };
        if (!active) return;
        setReminders(mapApiReminderItems(data.reminders ?? []));
      } catch {
        /* ignore */
      }
    };

    const handleReminderChange = (event: Event) => {
      const detail = (event as CustomEvent<ReminderChangeDetail>).detail;
      if (!detail?.reminders) return;
      setReminders(detail.reminders);
    };

    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") void load();
    };

    const tickId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    const refreshId = window.setInterval(() => {
      void load();
    }, 60_000);

    void load();
    window.addEventListener("dashboard:reminders-changed", handleReminderChange);
    window.addEventListener("focus", refreshOnVisible);
    document.addEventListener("visibilitychange", refreshOnVisible);

    return () => {
      active = false;
      window.clearInterval(tickId);
      window.clearInterval(refreshId);
      window.removeEventListener("dashboard:reminders-changed", handleReminderChange);
      window.removeEventListener("focus", refreshOnVisible);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, []);

  const missedCount = useMemo(() => countMissedReminders(reminders, nowMs), [reminders, nowMs]);
  const badgeLabel = missedCount > 99 ? "99+" : String(missedCount);
  const ariaLabel =
    missedCount > 0
      ? `Open reminders. ${missedCount} overdue reminder${missedCount === 1 ? "" : "s"}`
      : "Open reminders";
  const title =
    missedCount > 0
      ? `${missedCount} overdue reminder${missedCount === 1 ? "" : "s"}`
      : "Open reminders";

  // On the dashboard the bottom-nav Reminders tab already provides bell / reminder
  // access at mobile and tablet viewports — rendering this header bell there too
  // would show a visible duplicate. All hooks are already called above so this
  // conditional return is safe per the Rules of Hooks.
  if (pathname === "/dashboard") return null;

  return (
    <button
      type="button"
      onClick={() => {
        if (pathname === "/dashboard") {
          window.dispatchEvent(new CustomEvent("dashboard:open-reminders"));
        } else {
          router.push("/dashboard?open=reminders");
        }
      }}
      data-testid="open-reminders-button"
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full border bg-white shadow-sm transition sm:h-10 sm:w-10 dark:bg-slate-900 ${
        missedCount > 0
          ? "border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-950/40"
          : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
      }`}
      aria-label={ariaLabel}
      title={title}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {missedCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm">
          {badgeLabel}
        </span>
      ) : null}
    </button>
  );
}
