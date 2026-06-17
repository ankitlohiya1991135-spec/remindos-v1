/**
 * Harness for weekday + recurrence parsing. Run:
 *   npx tsx apps/web/app/api/chat/_lib/datetime.harness.ts
 *
 * Covers the "every thrusday 3pm" class of bugs: misspelled weekday → correct
 * day (not "today"), and "every <weekday>" → weekly recurrence.
 */

import { parseDateTimeFromInput, findWeekday, WEEKDAY_ALIASES } from "./datetime";
import { extractRecurrenceFromInput, extractTitleFromCreateInput } from "./extract";

const WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) { failures++; console.error(`✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const TZ = "Asia/Kolkata";
function weekdayOfIso(iso: string): number {
  // Day-of-week in the user's tz.
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: TZ }).format(new Date(iso)).toLowerCase();
  return WD.indexOf(wd);
}

// ── 1. Misspelled / abbreviated weekdays resolve to the right day, in the future ──
const cases: { input: string; day: number }[] = [
  { input: "fill timesheet every thrusday 3pm", day: 4 },
  { input: "remind me every thursday at 3pm", day: 4 },
  { input: "standup on wensday 9am", day: 3 },
  { input: "call mom this tuesfay 6pm", day: 2 },
  { input: "gym saterday 7am", day: 6 },
  { input: "review next friday 5pm", day: 5 },
  { input: "groceries on sundy 11am", day: 0 },
  { input: "team sync munday 10am", day: 1 },
];
for (const c of cases) {
  const iso = parseDateTimeFromInput(c.input, TZ);
  check(`weekday parsed: "${c.input}"`, typeof iso === "string", String(iso));
  if (typeof iso === "string") {
    check(`  → lands on ${WD[c.day]}`, weekdayOfIso(iso) === c.day, `got ${WD[weekdayOfIso(iso)]} (${iso})`);
    check(`  → in the future`, new Date(iso).getTime() > Date.now(), iso);
  }
}

// ── 2. "every <weekday>" → weekly recurrence ──
check('every thrusday → weekly', extractRecurrenceFromInput("fill timesheet every thrusday 3pm") === "weekly");
check('every thursday → weekly', extractRecurrenceFromInput("remind me every thursday 3pm") === "weekly");
check('each friday → weekly', extractRecurrenceFromInput("each friday review 5pm") === "weekly");
check('every week → weekly', extractRecurrenceFromInput("do it every week") === "weekly");
check('everyday → daily', extractRecurrenceFromInput("water plants everyday 8am") === "daily");
check('every month → monthly', extractRecurrenceFromInput("rent every month") === "monthly");

// ── 3. No false recurrence when there's no "every"/"each" ──
check('plain "on thursday" is NOT recurring', extractRecurrenceFromInput("meeting on thursday 3pm") === undefined);
check('"someday" is not a weekday recurrence', extractRecurrenceFromInput("every someday maybe") === undefined);

// ── 4. Title strips the (misspelled) weekday token ──
const t1 = extractTitleFromCreateInput("Set a reminder to fill usb clarity timesheet every thrusday 3pm");
check('title drops "thrusday"', !!t1 && !/thrus|thursday/i.test(t1), `title="${t1}"`);
check('title keeps the real subject', !!t1 && /fill usb clarity timesheet/i.test(t1), `title="${t1}"`);

// ── 5. findWeekday sanity (alias vs fuzzy, and no short-word false positives) ──
check('alias: thrusday → 4', findWeekday("thrusday")?.index === 4);
check('fuzzy: thursdya → 4', findWeekday("thursdya")?.index === 4);
check('no match in plain sentence', findWeekday("please buy milk and eggs") === null);
check('alias map has thrusday', WEEKDAY_ALIASES["thrusday"] === 4);

// ── Report ──
if (failures === 0) { console.log("✓ ALL PASS"); process.exit(0); }
else { console.error(`\n✗ ${failures} FAILURE(S)`); process.exit(1); }
