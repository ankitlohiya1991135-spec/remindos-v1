import Link from "next/link";
import type { CSSProperties } from "react";

/* -------------------------------------------------------------------------- */
/*  Data                                                                      */
/* -------------------------------------------------------------------------- */

const HERO_AREAS = [
  { label: "Tasks", value: 65, color: "#2563eb" },
  { label: "Health", value: 90, color: "#10b981" },
  { label: "Wealth", value: 78, color: "#8b5cf6" },
  { label: "Relations", value: 88, color: "#f59e0b" },
  { label: "Growth", value: 92, color: "#0ea5e9" },
];

const TRUST_STATS = [
  { value: "50,000+", label: "Active members" },
  { value: "4.9 ★", label: "App store rating" },
  { value: "2.1M", label: "Habits completed" },
  { value: "92%", label: "Feel more in control" },
];

const ENTROPY_APPS = [
  "Goals App",
  "Habit Tracker",
  "Finance Sheet",
  "Calendar",
  "Journal",
  "Notes",
  "Health App",
  "Budget App",
  "Tasks",
  "Reminders",
];

const LIFE_SCORE = [
  { label: "Peace", caption: "Calm & clarity", value: 82, color: "#8b5cf6" },
  { label: "Health", caption: "Body & energy", value: 91, color: "#f43f5e" },
  { label: "Wealth", caption: "Money & assets", value: 74, color: "#10b981" },
  { label: "Relations", caption: "Social & family", value: 68, color: "#f59e0b" },
  { label: "Growth", caption: "Skills & goals", value: 95, color: "#0ea5e9" },
];

const INSIGHTS = [
  {
    tag: "Productivity",
    title: "Sleep & focus",
    body: "Your productivity increases 22% on days you log 7+ hours of sleep.",
  },
  {
    tag: "Finance",
    title: "Spending pattern",
    body: "Discretionary spending rises when your Peace Score drops below 60.",
  },
  {
    tag: "Health",
    title: "Movement matters",
    body: "You achieve more long-term goals when you exercise at least 3 times per week.",
  },
  {
    tag: "Relationships",
    title: "Social dynamics",
    body: "Weeks with 2+ meaningful social sessions correlate with a higher Life Score.",
  },
];

const PILLARS = [
  {
    kicker: "Goals",
    title: "Aim with intention.",
    titleAccent: "Hit with confidence.",
    body: "Set quarterly goals, break them into weekly milestones, and watch your progress compound — no more abandoned January resolutions.",
    points: ["Quarterly OKR-style goals", "Auto progress from habits", "Deadline & milestone tracking"],
    preview: "goals" as const,
    reverse: false,
  },
  {
    kicker: "Habits",
    title: "Build consistency.",
    titleAccent: "Become the person you want to be.",
    body: "Identity-based habits that link directly to your goals. When your daily actions align with who you're becoming, progress feels effortless.",
    points: ["Identity-based loops", "Streak protection", "AI-tuned reminders"],
    preview: "habits" as const,
    reverse: true,
  },
  {
    kicker: "Finance",
    title: "Total financial clarity",
    titleAccent: "without the spreadsheets.",
    body: "Net worth tracking, automated budgeting, and goal-based saving. See the impact of today's spending on your future self.",
    points: ["Net worth at a glance", "Smart budgets", "Future-self projections"],
    preview: "finance" as const,
    reverse: false,
  },
  {
    kicker: "Health",
    title: "Energy is",
    titleAccent: "the ultimate currency.",
    body: "Connect Apple Health and Google Fit. RemindOS turns your vitals into actionable insight tied to the rest of your life.",
    points: ["Sleep, steps & heart rate", "Workout log", "Energy correlation"],
    preview: "health" as const,
    reverse: true,
  },
];

const TRANSFORMATION = [
  {
    step: "01",
    title: "From scattered to unified",
    body: "Connect your calendar, bank, and health data. See your first correlations in days.",
  },
  {
    step: "02",
    title: "Data-driven decisions",
    body: "AI Coach starts suggesting schedule shifts that protect your energy peaks.",
  },
  {
    step: "03",
    title: "Operating at peak intention",
    body: "Your Life Score stabilizes at 80+. Weeks feel effortless and purposeful.",
  },
];

const BEFORE = [
  "Overwhelmed by tabs and apps",
  "Reacting to every notification",
  "Goals forgotten by February",
];
const AFTER = [
  "Organized, calm, intentional",
  "One dashboard for every decision",
  "Compound progress, year after year",
];

const MOMENTUM = [
  { value: "42", label: "Day streak", color: "#f59e0b" },
  { value: "18", label: "Milestones hit", color: "#10b981" },
  { value: "7", label: "Weekly wins", color: "#8b5cf6" },
  { value: "92", label: "Habits completed", color: "#f43f5e" },
];

const INTEGRATIONS = [
  "Google Calendar",
  "Gmail",
  "Apple Health",
  "Google Fit",
  "Notion",
  "Slack",
  "Strava",
  "Plaid",
  "Spotify",
  "Linear",
  "GitHub",
  "Todoist",
];

const COMPARISON = [
  "Goals",
  "Habits",
  "Health",
  "Finance",
  "Relationships",
  "Journaling",
  "Weekly Reviews",
  "AI Insights",
];

const TESTIMONIALS = [
  {
    quote: "RemindOS replaced six apps in my life. I finally feel like the CEO of my own week.",
    name: "Maya R.",
    role: "Product Designer",
  },
  {
    quote: "The Life Score is genius. Seeing one number that captures everything keeps me honest.",
    name: "Daniel K.",
    role: "Founder",
  },
  {
    quote: "I've never stuck with a habit tracker. Six months in with RemindOS and counting.",
    name: "Priya S.",
    role: "Engineer",
  },
];

const PRICING = {
  free: {
    name: "Free",
    price: "$0",
    blurb: "Get started with the essentials.",
    points: ["Basic habit & goal tracking", "One calendar sync", "Weekly review"],
  },
  pro: {
    name: "Pro",
    price: "$12",
    period: "/mo",
    blurb: "The full Personal Operating System.",
    points: [
      "Full Life Score analytics",
      "AI Coach & insights",
      "Unlimited integrations",
      "Finance & health sync",
      "Priority support",
    ],
  },
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function revealStyle(index: number, step = 90): CSSProperties {
  return { "--lp-delay": `${index * step}ms` } as CSSProperties;
}

function Gauge({
  value,
  color,
  size = 56,
  stroke = 5,
}: {
  value: number;
  color: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - value / 100);
  const center = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-slate-200 dark:stroke-slate-700"
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${center} ${center})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-slate-900 dark:fill-slate-100"
        style={{ fontSize: size * 0.3, fontWeight: 700 }}
      >
        {value}
      </text>
    </svg>
  );
}

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

const SECTION = "mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8";
const KICKER = "text-[11px] font-bold uppercase tracking-[0.22em] text-blue-600";
const HEADING = "mt-3 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-4xl";

/* -------------------------------------------------------------------------- */
/*  Pillar preview mocks                                                       */
/* -------------------------------------------------------------------------- */

function PillarPreview({ kind }: { kind: "goals" | "habits" | "finance" | "health" }) {
  const shell =
    "rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_30px_60px_-40px_rgba(15,23,42,0.45)] dark:border-slate-700 dark:bg-slate-900";

  if (kind === "goals") {
    return (
      <div className={shell}>
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Goals</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {[
            { label: "Quarterly Goal", pct: 64 },
            { label: "Quarterly Goal", pct: 82 },
          ].map((g, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">{g.label}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{g.pct}%</p>
              <div className="mt-2 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700">
                <div className="h-1.5 rounded-full bg-blue-600" style={{ width: `${g.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-2">
          {["Ship v2 launch", "Read 12 books", "Run a half marathon"].map((m) => (
            <div key={m} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
              <Check /> {m}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (kind === "habits") {
    return (
      <div className={shell}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Habit Tracker</p>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            42 day streak
          </span>
        </div>
        <div className="mt-4 grid grid-cols-7 gap-1.5">
          {Array.from({ length: 35 }).map((_, i) => {
            const on = (i * 7) % 11 < 8;
            return (
              <span
                key={i}
                className={`aspect-square rounded-[4px] ${on ? "bg-emerald-500" : "bg-slate-200 dark:bg-slate-700"}`}
              />
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] text-slate-500">
          {["Read", "Meditate", "Workout"].map((h) => (
            <div key={h} className="rounded-lg border border-slate-200 py-2 dark:border-slate-700">{h}</div>
          ))}
        </div>
      </div>
    );
  }

  if (kind === "finance") {
    return (
      <div className={shell}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Net Worth</p>
          <span className="text-xs font-semibold text-emerald-600">+12.4%</span>
        </div>
        <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">$125,230</p>
        <svg viewBox="0 0 240 80" className="mt-3 w-full">
          <polyline
            points="0,70 30,62 60,64 90,50 120,52 150,38 180,30 210,22 240,12"
            fill="none"
            stroke="#2563eb"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[10px]">
          {[
            { l: "Income", v: "$8.2k" },
            { l: "Spending", v: "$3.1k" },
            { l: "Saved", v: "$5.1k" },
          ].map((s) => (
            <div key={s.l} className="rounded-lg border border-slate-200 py-2 dark:border-slate-700">
              <p className="font-bold text-slate-900 dark:text-slate-100">{s.v}</p>
              <p className="text-slate-500">{s.l}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // health
  return (
    <div className={shell}>
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Health Vitals</p>
      <div className="mt-4 flex items-center gap-4">
        <Gauge value={91} color="#f43f5e" size={72} />
        <div className="space-y-1.5 text-xs">
          <p className="text-slate-500">Sleep duration</p>
          <p className="text-lg font-bold text-slate-900 dark:text-slate-100">7h 42m</p>
          <p className="text-emerald-600">Resting HR 58 bpm</p>
        </div>
      </div>
      <div className="mt-4 flex items-end gap-1.5">
        {[40, 65, 50, 80, 60, 90, 70].map((h, i) => (
          <span key={i} className="flex-1 rounded-t bg-rose-400/70" style={{ height: `${h * 0.5}px` }} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export function LandingPage() {
  return (
    <main className="bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* ---------------------------------------------------------------- Hero */}
      <section className="relative overflow-hidden bg-[#f7f9ff] dark:bg-slate-950">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem] bg-[radial-gradient(circle_at_50%_-10%,rgba(37,99,235,0.18),transparent_55%)]" />
        <div className={`${SECTION} pb-16 pt-16 text-center sm:pt-20`}>
          <span style={revealStyle(0)} className="lp-reveal inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3.5 py-1.5 text-xs font-semibold text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
            ✦ The Personal Operating System
          </span>
          <h1 style={revealStyle(1)} className="lp-reveal mx-auto mt-6 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Your Entire Life.
            <br />
            <span className="text-blue-600">One Dashboard.</span>
          </h1>
          <p style={revealStyle(2)} className="lp-reveal mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-600 dark:text-slate-300 sm:text-lg">
            Goals, habits, health, finances, and AI-powered insights — organized into a single, calm
            operating system for your future self.
          </p>
          <div style={revealStyle(3)} className="lp-reveal mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              data-testid="landing-start-free"
              className="lp-cta-main rounded-full bg-blue-600 px-7 py-3 text-sm font-semibold text-white shadow-[0_16px_30px_-16px_rgba(37,99,235,0.9)] transition hover:-translate-y-0.5 hover:bg-blue-500"
            >
              Start Free
            </Link>
            <Link
              href="/sign-in"
              data-testid="landing-sign-in"
              className="rounded-full border border-slate-300 bg-white px-7 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              ▶ Watch Demo
            </Link>
          </div>
          <p style={revealStyle(4)} className="lp-reveal mt-4 text-xs text-slate-500">No credit card required</p>

          {/* Dashboard preview */}
          <div style={revealStyle(5)} className="lp-reveal mx-auto mt-14 max-w-5xl">
            <DashboardPreview />
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- Stats */}
      <section className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className={`${SECTION} grid grid-cols-2 gap-6 py-12 sm:grid-cols-4`}>
          {TRUST_STATS.map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-3xl font-bold text-slate-900 dark:text-slate-100">{s.value}</p>
              <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ Entropy problem */}
      <section className="bg-[#f7f9ff] dark:bg-slate-900/40">
        <div className={`${SECTION} py-20 text-center`}>
          <p className={KICKER}>The Entropy Problem</p>
          <h2 className={HEADING}>
            Stop managing your life
            <br className="hidden sm:block" /> across 10 different apps.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm text-slate-600 dark:text-slate-300">
            Context switching kills focus. When your goals live in one app and your finances in
            another, you lose the big picture.
          </p>
          <div className="mx-auto mt-10 flex max-w-3xl flex-wrap justify-center gap-2.5">
            {ENTROPY_APPS.map((app) => (
              <span
                key={app}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {app}
              </span>
            ))}
          </div>
          <p className="mt-8 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400">Collapse into</p>
          <div className="mx-auto mt-4 flex max-w-2xl items-center justify-center gap-3 rounded-2xl bg-slate-900 px-6 py-5 text-white shadow-xl dark:bg-slate-800">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold">R</span>
            <span className="text-base font-semibold">RemindOS</span>
            <span className="text-sm text-slate-400">— one calm dashboard</span>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Life Score */}
      <section className="bg-white dark:bg-slate-950">
        <div className={`${SECTION} py-20 text-center`}>
          <p className={KICKER}>Signature Feature</p>
          <h2 className={HEADING}>The Life Score™</h2>
          <p className="mx-auto mt-4 max-w-xl text-sm text-slate-600 dark:text-slate-300">
            A single, living metric for total life alignment — synthesized from your habits, finances,
            and health in real time.
          </p>
          <div className="mx-auto mt-12 flex max-w-3xl flex-wrap items-start justify-center gap-x-10 gap-y-6">
            {LIFE_SCORE.map((s) => (
              <div key={s.label} className="flex w-24 flex-col items-center gap-2">
                <Gauge value={s.value} color={s.color} size={72} />
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{s.label}</p>
                <p className="text-[11px] text-slate-500">{s.caption}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-12 max-w-md rounded-2xl border border-slate-200 bg-[#f7f9ff] p-6 dark:border-slate-700 dark:bg-slate-900">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Total Life Alignment</p>
            <p className="mt-2 text-5xl font-bold text-blue-600">82.0</p>
            <p className="mt-1 text-xs text-emerald-600">+6 points vs. last month</p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- AI Intelligence */}
      <section className="bg-slate-950 text-white">
        <div className={`${SECTION} py-20`}>
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <p className={KICKER}>Synthetic Intelligence</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Intelligence that knows you.</h2>
            </div>
            <p className="max-w-sm text-sm text-slate-400">
              RemindOS analyzes connections across your data silos to surface what actually moves you
              thrive.
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {INSIGHTS.map((card) => (
              <article
                key={card.title}
                className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 transition hover:bg-white/[0.07]"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-400">{card.tag}</span>
                <h3 className="mt-2 text-base font-semibold">{card.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- Pillars */}
      <section className="bg-[#f7f9ff] dark:bg-slate-900/40">
        <div className={`${SECTION} py-20`}>
          <div className="text-center">
            <p className={KICKER}>One Platform</p>
            <h2 className={HEADING}>
              Every area of life.
              <br className="hidden sm:block" /> Beautifully connected.
            </h2>
          </div>
          <div className="mt-16 space-y-16">
            {PILLARS.map((p) => (
              <div
                key={p.kicker}
                className="grid items-center gap-8 lg:grid-cols-2"
              >
                <div className={p.reverse ? "lg:order-2" : ""}>
                  <p className={KICKER}>{p.kicker}</p>
                  <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
                    {p.title}
                    <br />
                    {p.titleAccent}
                  </h3>
                  <p className="mt-4 max-w-md text-sm leading-7 text-slate-600 dark:text-slate-300">{p.body}</p>
                  <ul className="mt-5 space-y-2">
                    {p.points.map((pt) => (
                      <li key={pt} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                        <Check /> {pt}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={p.reverse ? "lg:order-1" : ""}>
                  <PillarPreview kind={p.preview} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ Transformation */}
      <section className="bg-slate-950 text-white">
        <div className={`${SECTION} py-20`}>
          <div className="text-center">
            <p className={KICKER}>The Transformation</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">From overwhelmed to intentional.</h2>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {TRANSFORMATION.map((t) => (
              <article key={t.step} className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-bold">
                  {t.step.replace(/^0/, "")}
                </span>
                <h3 className="mt-4 text-base font-semibold">{t.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{t.body}</p>
              </article>
            ))}
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-rose-400">Before RemindOS</p>
              <ul className="mt-3 space-y-2">
                {BEFORE.map((b) => (
                  <li key={b} className="text-sm text-slate-400">— {b}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-400">After RemindOS</p>
              <ul className="mt-3 space-y-2">
                {AFTER.map((a) => (
                  <li key={a} className="flex items-start gap-2 text-sm text-slate-200">
                    <Check /> {a}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Momentum */}
      <section className="bg-white dark:bg-slate-950">
        <div className={`${SECTION} py-20 text-center`}>
          <p className={KICKER}>Momentum</p>
          <h2 className={HEADING}>Progress you can feel.</h2>
          <p className="mx-auto mt-4 max-w-xl text-sm text-slate-600 dark:text-slate-300">
            Streaks, milestones, and weekly wins keep you anchored to the person you're becoming.
          </p>
          <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {MOMENTUM.map((m) => (
              <div
                key={m.label}
                className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <span
                  className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={{ color: m.color, backgroundColor: `${m.color}1a` }}
                >
                  Active
                </span>
                <p className="mt-3 text-3xl font-bold text-slate-900 dark:text-slate-100">{m.value}</p>
                <p className="mt-1 text-xs text-slate-500">{m.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Integrations */}
      <section className="bg-[#f7f9ff] dark:bg-slate-900/40">
        <div className={`${SECTION} py-20 text-center`}>
          <p className={KICKER}>Integrations</p>
          <h2 className={HEADING}>
            Connect the tools
            <br className="hidden sm:block" /> you already use.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm text-slate-600 dark:text-slate-300">
            RemindOS plays well with everything. Plug in once and let the data flow.
          </p>
          <div className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {INTEGRATIONS.map((name) => (
              <span
                key={name}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- Comparison */}
      <section className="bg-white dark:bg-slate-950">
        <div className={`${SECTION} py-20`}>
          <div className="text-center">
            <p className={KICKER}>All-in-one</p>
            <h2 className={HEADING}>RemindOS vs. ten different apps.</h2>
          </div>
          <div className="mx-auto mt-10 max-w-2xl overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700">
            <div className="grid grid-cols-3 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800/60">
              <span>Capability</span>
              <span className="text-center">Other apps</span>
              <span className="text-right text-blue-600">RemindOS</span>
            </div>
            {COMPARISON.map((row, i) => (
              <div
                key={row}
                className={`grid grid-cols-3 items-center px-5 py-3 text-sm ${
                  i % 2 ? "bg-slate-50/50 dark:bg-slate-900/40" : "bg-white dark:bg-slate-950"
                }`}
              >
                <span className="font-medium text-slate-700 dark:text-slate-200">{row}</span>
                <span className="text-center text-slate-400">Separate app</span>
                <span className="flex items-center justify-end gap-1 font-semibold text-blue-600">
                  <Check /> Built-in
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Testimonials */}
      <section className="bg-[#f7f9ff] dark:bg-slate-900/40">
        <div className={`${SECTION} py-20`}>
          <div className="text-center">
            <p className={KICKER}>Loved by people</p>
            <h2 className={HEADING}>Real stories. Real momentum.</h2>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {TESTIMONIALS.map((t) => (
              <figure
                key={t.name}
                className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="text-sm text-amber-400">★★★★★</div>
                <blockquote className="mt-3 text-sm leading-6 text-slate-700 dark:text-slate-200">
                  “{t.quote}”
                </blockquote>
                <figcaption className="mt-4 flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                    {t.name[0]}
                  </span>
                  <span>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t.name}</p>
                    <p className="text-xs text-slate-500">{t.role}</p>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Pricing */}
      <section className="bg-white dark:bg-slate-950">
        <div className={`${SECTION} py-20`}>
          <div className="text-center">
            <p className={KICKER}>Pricing</p>
            <h2 className={HEADING}>Simple pricing for a complex life.</h2>
          </div>
          <div className="mx-auto mt-12 grid max-w-3xl gap-5 md:grid-cols-2">
            {/* Free */}
            <div className="rounded-2xl border border-slate-200 bg-white p-7 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-sm font-semibold text-slate-500">{PRICING.free.name}</p>
              <p className="mt-2 text-4xl font-bold text-slate-900 dark:text-slate-100">{PRICING.free.price}</p>
              <p className="mt-1 text-xs text-slate-500">{PRICING.free.blurb}</p>
              <ul className="mt-6 space-y-2.5">
                {PRICING.free.points.map((pt) => (
                  <li key={pt} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <Check /> {pt}
                  </li>
                ))}
              </ul>
              <Link
                href="/sign-up"
                className="mt-7 block rounded-full border border-slate-300 bg-white py-3 text-center text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Start Free
              </Link>
            </div>
            {/* Pro */}
            <div className="relative rounded-2xl border-2 border-blue-600 bg-white p-7 shadow-[0_30px_60px_-40px_rgba(37,99,235,0.6)] dark:bg-slate-900">
              <span className="absolute right-6 top-6 rounded-full bg-blue-600 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                Recommended
              </span>
              <p className="text-sm font-semibold text-blue-600">{PRICING.pro.name}</p>
              <p className="mt-2 text-4xl font-bold text-slate-900 dark:text-slate-100">
                {PRICING.pro.price}
                <span className="text-base font-medium text-slate-500">{PRICING.pro.period}</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">{PRICING.pro.blurb}</p>
              <ul className="mt-6 space-y-2.5">
                {PRICING.pro.points.map((pt) => (
                  <li key={pt} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <Check /> {pt}
                  </li>
                ))}
              </ul>
              <Link
                href="/sign-up"
                className="lp-cta-main mt-7 block rounded-full bg-blue-600 py-3 text-center text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Get Pro
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Final CTA */}
      <section className="bg-white px-4 pb-20 dark:bg-slate-950">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-[linear-gradient(135deg,#2563eb_0%,#4f46e5_100%)] px-6 py-16 text-center text-white shadow-[0_40px_80px_-50px_rgba(37,99,235,0.9)]">
          <h2 className="mx-auto max-w-xl text-3xl font-bold tracking-tight sm:text-4xl">
            Start Running Your Life With Intention.
          </h2>
          <p className="mt-4 text-sm text-blue-100">Everything that matters. One dashboard.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="rounded-full bg-white px-7 py-3 text-sm font-semibold text-blue-700 transition hover:-translate-y-0.5 hover:bg-blue-50"
            >
              Get Started Free
            </Link>
            <Link
              href="/sign-in"
              className="rounded-full border border-white/60 bg-white/10 px-7 py-3 text-sm font-semibold text-white transition hover:bg-white/20"
            >
              Book a Demo
            </Link>
          </div>
          <p className="mt-6 text-xs text-blue-200">Join 50,000+ humans building a better operating system.</p>
        </div>
      </section>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className={`${SECTION} flex flex-col items-center justify-between gap-4 py-8 sm:flex-row`}>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-xs font-bold text-white">R</span>
            <span className="text-sm font-semibold">RemindOS</span>
          </div>
          <nav className="flex gap-6 text-xs text-slate-500">
            <Link href="/sign-in" className="hover:text-slate-900 dark:hover:text-slate-200">Privacy</Link>
            <Link href="/sign-in" className="hover:text-slate-900 dark:hover:text-slate-200">Security</Link>
            <Link href="/sign-in" className="hover:text-slate-900 dark:hover:text-slate-200">Changelog</Link>
            <Link href="/sign-in" className="hover:text-slate-900 dark:hover:text-slate-200">Contact</Link>
          </nav>
          <p className="text-xs text-slate-400">© 2026 RemindOS</p>
        </div>
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero dashboard preview                                                     */
/* -------------------------------------------------------------------------- */

function DashboardPreview() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-[0_50px_100px_-50px_rgba(37,99,235,0.45)] dark:border-slate-700 dark:bg-slate-900 sm:p-4">
      {/* top bar */}
      <div className="flex items-center justify-between border-b border-slate-200 px-2 pb-3 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-[11px] font-bold text-white">R</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">RemindOS</span>
        </div>
        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          88% Intentional
        </span>
      </div>

      <div className="grid gap-3 p-2 sm:grid-cols-3">
        {/* Life Score */}
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-[#f7f9ff] p-4 dark:border-slate-700 dark:bg-slate-800/40">
          <p className="text-xs font-semibold text-slate-500">Life Score</p>
          <div className="mt-2">
            <Gauge value={87} color="#2563eb" size={96} stroke={7} />
          </div>
          <p className="mt-2 text-[11px] text-emerald-600">+4 this week</p>
        </div>

        {/* Areas + schedule */}
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700 sm:col-span-2">
          <p className="text-left text-xs font-semibold text-slate-500">Areas</p>
          <div className="mt-3 flex flex-wrap justify-between gap-3">
            {HERO_AREAS.map((a) => (
              <div key={a.label} className="flex flex-col items-center gap-1">
                <Gauge value={a.value} color={a.color} size={48} stroke={4} />
                <span className="text-[10px] text-slate-500">{a.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            <p className="text-xs font-semibold text-slate-500">Today's Schedule</p>
            {[
              { t: "Morning workout", time: "7:00 AM", c: "#10b981" },
              { t: "Team sync", time: "11:30 AM", c: "#2563eb" },
              { t: "Deep work block", time: "2:00 PM", c: "#8b5cf6" },
            ].map((s) => (
              <div key={s.t} className="flex items-center gap-2 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.c }} />
                <span className="flex-1 text-slate-700 dark:text-slate-200">{s.t}</span>
                <span className="text-slate-400">{s.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
