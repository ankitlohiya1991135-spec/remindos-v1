import type { ReactNode } from "react";
import Link from "next/link";

interface AuthShellProps {
  badge: string;
  title: string;
  description: string;
  alternateHref: string;
  alternateLabel: string;
  children: ReactNode;
}

const valuePoints = [
  "Goals, habits, health, and finances in one calm dashboard.",
  "AI-powered insights that surface what actually moves you.",
  "Gentle, supportive reminders — never naggy, never overwhelming.",
];

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function AuthShell({
  badge,
  title,
  description,
  alternateHref,
  alternateLabel,
  children,
}: AuthShellProps) {
  return (
    <main className="relative isolate min-h-[calc(100svh-64px)] overflow-hidden bg-[#f7f9ff] px-4 py-[max(2rem,env(safe-area-inset-top))] text-slate-900 dark:bg-slate-950 dark:text-slate-100 sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-[radial-gradient(circle_at_50%_-10%,rgba(37,99,235,0.16),transparent_55%)]" />
      <div className="mx-auto grid min-h-full w-full max-w-6xl gap-8 pb-[max(2rem,env(safe-area-inset-bottom))] lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,28rem)] lg:items-center">
        {/* Left — brand story */}
        <section className="lg:pr-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3.5 py-1.5 text-xs font-semibold text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
            ✦ {badge}
          </span>
          <h1 className="mt-6 max-w-xl text-3xl font-bold leading-[1.1] tracking-tight sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-slate-600 dark:text-slate-300">
            {description}
          </p>
          <ul className="mt-8 space-y-3">
            {valuePoints.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-200">
                <Check />
                {point}
              </li>
            ))}
          </ul>
        </section>

        {/* Right — auth card */}
        <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_40px_80px_-50px_rgba(37,99,235,0.5)] dark:border-slate-700 dark:bg-slate-900 sm:p-7">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white">
                R
              </span>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Account access
                </p>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">RemindOS workspace</p>
              </div>
            </div>
            <Link
              href={alternateHref}
              className="rounded-full border border-slate-300 px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {alternateLabel}
            </Link>
          </div>
          <div className="[&_.cl-card]:shadow-none [&_.cl-footerAction]:justify-center [&_.cl-footerActionLink]:font-semibold [&_.cl-header]:hidden [&_.cl-rootBox]:w-full [&_.cl-socialButtonsBlockButton]:shadow-none">
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}
