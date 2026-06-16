/**
 * Exhaustive harness for the notification engine. Run:
 *   npx tsx apps/web/lib/server/notifications/engine.harness.ts
 *
 * Verifies: tier determination, anti-surveillance safety across every
 * type × tier × seed, cold-start never fabricates patterns, and the selection
 * silence/priority rules.
 */

import {
  determineTier,
  selectNotification,
  generateNotification,
  isCopyClean,
  ALL_TYPES,
  DAILY_CAP,
  type Tier,
  type CopyContext,
  type SelectionState,
  type NotificationType,
} from "./engine";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) {
    failures++;
    console.error(`✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── 1. Tier determination ──────────────────────────────────────────────────
check("day-0 user → tier 1", determineTier({ accountAgeDays: 0, activeDaysCount: 0, totalCompletions: 0 }) === 1);
check("day-2 power user still tier 1 (age gate)", determineTier({ accountAgeDays: 2, activeDaysCount: 2, totalCompletions: 9 }) === 1);
check("day-6 with some data → tier 2", determineTier({ accountAgeDays: 6, activeDaysCount: 3, totalCompletions: 4 }) === 2);
check("day-30 but barely used → tier 1 (data gate)", determineTier({ accountAgeDays: 30, activeDaysCount: 1, totalCompletions: 0 }) === 1);
check("day-30 light use → tier 2 (data gate caps it)", determineTier({ accountAgeDays: 30, activeDaysCount: 3, totalCompletions: 2 }) === 2);
check("day-20 rich → tier 3", determineTier({ accountAgeDays: 20, activeDaysCount: 10, totalCompletions: 12 }) === 3);

// ── 2. Anti-surveillance safety across the whole matrix ──────────────────────
const tiers: Tier[] = [1, 2, 3];
const richCtx = (tier: Tier, seed: number): CopyContext => ({
  tier,
  displayName: "Alex Morgan",
  focusTaskTitle: "finish the demo slides",
  nextDueTitle: "dentist appointment",
  minutesUntilDue: 75,
  completedTaskTitle: "file the tax documents",
  completedTaskAgeDays: 4,
  pendingCount: 6,
  overdueCount: 3,
  doneToday: 4,
  peakWindowLabel: "before 11am",
  addedRepeatedly: true,
  streakDays: 9,
  seed,
});

let copySamples = 0;
for (const type of ALL_TYPES) {
  for (const tier of tiers) {
    for (let seed = 0; seed < 40; seed++) {
      const c = generateNotification(type, richCtx(tier, seed));
      copySamples++;
      check(`copy clean: ${type} t${tier} seed${seed}`, isCopyClean(c), `${c.title} / ${c.body}`);
      check(`copy non-empty: ${type} t${tier}`, c.title.length > 0 && c.body.length > 0);
    }
  }
}

// ── 3. Cold-start (tier 1) must NOT fabricate patterns even if fields are passed ──
for (let seed = 0; seed < 40; seed++) {
  const ml = generateNotification("morning_launch", richCtx(1, seed));
  check("t1 morning_launch hides peak-window pattern", !/before 11am|at your best|sharpest/i.test(`${ml.title} ${ml.body}`), ml.body);

  const win = generateNotification("win_celebration", richCtx(1, seed));
  check("t1 win_celebration makes no age claim", !/\b\d+\s*days?\b/i.test(`${win.title} ${win.body}`), win.body);

  const ec = generateNotification("evening_soft_close", { ...richCtx(1, seed), doneToday: 0 });
  check("t1 evening with 0 done makes no count claim", !/\b\d+\s+(things?|done)\b/i.test(`${ec.title} ${ec.body}`), ec.body);
}

// A genuinely-new user (no task title yet) should still get warm, valid copy.
for (let seed = 0; seed < 20; seed++) {
  const bare: CopyContext = { tier: 1, pendingCount: 0, overdueCount: 0, doneToday: 0, seed };
  for (const type of ALL_TYPES) {
    const c = generateNotification(type, bare);
    check(`bare-ctx clean: ${type} seed${seed}`, isCopyClean(c) && c.body.length > 0, `${c.title} / ${c.body}`);
  }
}

// ── 4. Selection: silence rules ──────────────────────────────────────────────
const baseState = (over: Partial<SelectionState> = {}): SelectionState => ({
  tier: 3,
  localHour: 14,
  isWeekend: false,
  quietHours: false,
  sentInLast24h: 0,
  minutesSinceLastNotif: null,
  lastWasDismissed: false,
  inCompletionFlow: false,
  justCompletedTask: false,
  isMorningWindow: false,
  isEveningWindow: false,
  stressDetected: false,
  hasApproachingTimedTask: false,
  hasIdlePendingTask: false,
  ...over,
});

function silent(r: ReturnType<typeof selectNotification>): r is { silent: true; reason: string } {
  return "silent" in r;
}
function typeOf(r: ReturnType<typeof selectNotification>): NotificationType | null {
  return "type" in r ? r.type : null;
}

check("quiet hours → silent", silent(selectNotification(baseState({ quietHours: true, isMorningWindow: true }))));
check("daily cap reached → silent", silent(selectNotification(baseState({ sentInLast24h: DAILY_CAP, isMorningWindow: true }))));
check("in completion flow → silent", silent(selectNotification(baseState({ inCompletionFlow: true, hasIdlePendingTask: true }))));
check("cooldown active → silent", silent(selectNotification(baseState({ minutesSinceLastNotif: 30, hasIdlePendingTask: true }))));
check("dismissed → longer backoff blocks at 120m", silent(selectNotification(baseState({ lastWasDismissed: true, minutesSinceLastNotif: 120, hasIdlePendingTask: true }))));
check("nothing to say → silent", silent(selectNotification(baseState())));
check("weekend morning → silent", silent(selectNotification(baseState({ isWeekend: true, localHour: 8, isMorningWindow: true }))));

// ── 5. Selection: priority & win bypass ──────────────────────────────────────
check("win fires even past daily cap (reactive)", typeOf(selectNotification(baseState({ justCompletedTask: true, sentInLast24h: DAILY_CAP }))) === "win_celebration");
check("win still respects quiet hours", silent(selectNotification(baseState({ justCompletedTask: true, quietHours: true }))));
check("stress (tier3) → overwhelm_rescue", typeOf(selectNotification(baseState({ stressDetected: true, isMorningWindow: true }))) === "overwhelm_rescue");
check("stress at tier1 does NOT trigger rescue", typeOf(selectNotification(baseState({ tier: 1, stressDetected: true, isMorningWindow: true }))) === "morning_launch");
check("morning window → morning_launch", typeOf(selectNotification(baseState({ isMorningWindow: true }))) === "morning_launch");
check("evening window → evening_soft_close", typeOf(selectNotification(baseState({ isEveningWindow: true }))) === "evening_soft_close");
check("approaching timed task → time_anchor", typeOf(selectNotification(baseState({ hasApproachingTimedTask: true }))) === "time_anchor");
check("idle pending → just_start", typeOf(selectNotification(baseState({ hasIdlePendingTask: true }))) === "just_start");

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nchecked ${copySamples} copy samples + tier/selection assertions.`);
if (failures === 0) {
  console.log("✓ ALL PASS");
  process.exit(0);
} else {
  console.error(`\n✗ ${failures} FAILURE(S)`);
  process.exit(1);
}
