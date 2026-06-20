/**
 * Harness for weekday + recurrence parsing. Run:
 *   npx tsx apps/web/app/api/chat/_lib/datetime.harness.ts
 *
 * Covers the "every thrusday 3pm" class of bugs: misspelled weekday → correct
 * day (not "today"), and "every <weekday>" → weekly recurrence.
 */

import { parseDateTimeFromInput, parseCalendarDateFromInput, findWeekday, WEEKDAY_ALIASES } from "./datetime";
import { extractRecurrenceFromInput, extractTitleFromCreateInput } from "./extract";
import { looksLikeCreateIntent, looksLikeImplicitCreate } from "@repo/reminder";
import { classifyPromptDeterministic } from "./classify";

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

// ── 6. Explicit DATE without a time must be kept (the "jun 20 → jun 18" bug) ──
const d1 = parseCalendarDateFromInput("set a reminder to pay the jewel loan by jun 20", TZ);
check('date-only "by jun 20" → June 20', !!d1 && d1.month === 6 && d1.day === 20, JSON.stringify(d1));
const d2 = parseCalendarDateFromInput("pay the loan by saturday of this week", TZ);
check('date-only "saturday" → a Saturday', !!d2 && new Date(Date.UTC(d2.year, d2.month - 1, d2.day)).getUTCDay() === 6, JSON.stringify(d2));
const d3 = parseCalendarDateFromInput("pay rent on 6/20", TZ);
check('date-only "6/20" → June 20', !!d3 && d3.month === 6 && d3.day === 20, JSON.stringify(d3));
check('no date present → null', parseCalendarDateFromInput("remind me to call santosh", TZ) === null);

// ── 7. Title pollution fixes (the exact transcript cases) ──
const tA = extractTitleFromCreateInput("set a reminder to pay the jewel loan by jun 20");
check('title: no leftover "20"', !!tA && !/\b20\b/.test(tA) && /jewel loan/i.test(tA), `title="${tA}"`);
const tB = extractTitleFromCreateInput("pay the jewel loan by Saturday of this week");
check('title: no "of week"/"saturday"', !!tB && !/week|saturday/i.test(tB), `title="${tB}"`);
const tC = extractTitleFromCreateInput("Remind me to call Santosh by 5:45 p.m.");
check('title: "call Santosh" (no trailing ".")', tC === "call Santosh", `title="${tC}"`);

// ── 8. Natural prompts must be recognized as create (the "normal prompt not working" bug) ──
const detect = (m: string) => looksLikeCreateIntent(m) || looksLikeImplicitCreate(m);
for (const m of [
  "buy milk tomorrow",
  "call dentist at 3pm",
  "gym tomorrow 6am",
  "dentist appointment friday 3pm",
  "pay rent on the 1st",
  "submit report by friday",
  "team meeting monday 10am",
  "mom birthday june 20",
  "standup 9:30am",
  "pay loan by the 20th",
]) {
  check(`creates: "${m}"`, detect(m), "was not detected as a create");
}

// ── 9. Questions / mutations / chitchat must NOT be treated as create ──
for (const m of [
  "what's overdue?",
  "show my reminders",
  "how many reminders do i have",
  "did i set a reminder for gym",
  "move gym to tomorrow 6am",
  "mark gym done",
  "delete the dentist reminder",
  "reschedule meeting to friday",
  "thanks!",
  "how are you",
]) {
  check(`NOT create: "${m}"`, !detect(m), "false-positive create");
}

// ── 10. [#1] Natural mutation phrasings must classify as "mutate" (route to the right task) ──
for (const m of [
  "ticked off gym",
  "i did the dishes",
  "knocked it out",
  "gym is done",
  "got the report done",
  "mark gym done",
  "done with gym",
  "get rid of the dentist reminder",
  "scrap that reminder",
  "take gym off my list",
  "delete dentist",
  "remove the meeting",
  "push it back",
  "give me more time",
  "snooze gym",
  "bump that out",
]) {
  check(`mutate: "${m}"`, classifyPromptDeterministic(m) === "mutate", `got "${classifyPromptDeterministic(m)}"`);
}

// ── 11. [#1] Questions / future-intent must NOT be misread as a mutation ──
for (const m of [
  "is the gym done?",
  "i need to finish the report",
  "what did i complete today",
  "did i delete the dentist one",
]) {
  check(`NOT mutate: "${m}"`, classifyPromptDeterministic(m) !== "mutate", `got "${classifyPromptDeterministic(m)}"`);
}

// ── 12. [#2] Precedence guard relies on correct classification ──
// Detail/list queries must be "info" (so the deterministic answer handlers still run),
// general chat must be "other" (so the greedy handlers are skipped → LLM).
for (const m of ["tell me about gym", "details on the dentist reminder", "what's overdue", "show me my reminders"]) {
  check(`info: "${m}"`, classifyPromptDeterministic(m) === "info", `got "${classifyPromptDeterministic(m)}"`);
}
for (const m of ["how are you doing today", "what's the weather like", "tell me a joke", "thanks for the help"]) {
  check(`other: "${m}"`, classifyPromptDeterministic(m) === "other", `got "${classifyPromptDeterministic(m)}"`);
}

// ── 13. [#1-dominant] "remind me <time> to <action>" creates + clean title ──
const detect2 = (m: string) => looksLikeCreateIntent(m) || looksLikeImplicitCreate(m);
const createTitle: { input: string; title: string }[] = [
  { input: "Remind me in 2 hours to check the oven", title: "check the oven" },
  { input: "Remind me after 30 minutes to drink water", title: "drink water" },
  { input: "Set a reminder 1 hour from now for standup", title: "standup" },
  { input: "Remind me on Monday to submit the report", title: "submit the report" },
  { input: "Make sure I remember to call John", title: "call John" },
  { input: "Note this down — review PR before EOD", title: "review PR before EOD" },
  { input: "Remind me tomorrow at 2 PM to call John", title: "call John" },
];
for (const c of createTitle) {
  check(`[#1] creates: "${c.input}"`, detect2(c.input), "not detected as create");
  const t = extractTitleFromCreateInput(c.input);
  check(`[#1] title "${c.input}" → "${c.title}"`, t === c.title, `got "${t}"`);
}
// relative offsets resolve to a real future time
for (const m of ["Remind me in 2 hours to check the oven", "Remind me after 30 minutes to drink water", "1 hour from now standup"]) {
  const iso = parseDateTimeFromInput(m, TZ);
  check(`[#1] offset resolves: "${m}"`, typeof iso === "string" && new Date(iso).getTime() > Date.now(), String(iso));
}

// ── 14. [#2] time-of-day words + bare hour resolve to the right time ──
function hourOfIso(iso: string): number {
  return parseInt(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: TZ }).format(new Date(iso)), 10);
}
const timeCases: { input: string; hour: number }[] = [
  { input: "Remind me to sleep early tonight", hour: 21 },
  { input: "Remind me tonight to check emails", hour: 21 },
  { input: "call John by night", hour: 21 },
  { input: "in the evening for yoga", hour: 19 },
  { input: "team meeting tomorrow at 3", hour: 15 },   // bare hour 3 → 3 PM
  { input: "standup at 9 tomorrow", hour: 9 },          // bare hour 9 → 9 AM
  { input: "call dentist at 5", hour: 17 },             // bare hour 5 → 5 PM
  { input: "lunch at 1 tomorrow", hour: 13 },           // bare hour 1 → 1 PM
];
for (const c of timeCases) {
  const iso = parseDateTimeFromInput(c.input, TZ);
  check(`[#2] "${c.input}" → ${c.hour}:00`, typeof iso === "string" && hourOfIso(iso) === c.hour, `got ${iso ? hourOfIso(iso) + ":00" : "none"}`);
}
// titles drop the time words
for (const [input, title] of [
  ["I have a meeting with the client tomorrow at 3, remind me", "meeting with the client"],
  ["remind me in the evening for yoga", "yoga"],
  ["Remind me to sleep early tonight", "sleep early"],
] as const) {
  check(`[#2] title "${input}" → "${title}"`, extractTitleFromCreateInput(input) === title, `got "${extractTitleFromCreateInput(input)}"`);
}

// ── 15. [GUARDRAIL] The exact phrasings Manas reported — every one must CREATE,
//        with a clean title, and resolve to the correct day/time. Locks the
//        "it should just understand any phrasing" requirement against regression.
const isCreate = (m: string) => looksLikeCreateIntent(m) || looksLikeImplicitCreate(m);
function dowOfIso(iso: string): number {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(new Date(iso)).toLowerCase(),
  );
}

// (a) Each of these must be recognized as a create (never a list/no-op).
for (const m of [
  "Create a reminder for dentist appointment on Friday",
  "Create a reminder for dentist appointment on next Friday",
  "Remind me in 2 hours to check the oven",
  "Remind me after 30 minutes to drink water",
  "Set a reminder 1 hour from now for standup",
  "Remind me on Monday to submit the report",
  "Make sure I remember to call John by evening",
  "I need to remember to water the plants tonight",
  "Note this down — review PR before EOD",
  "I have a meeting with the client at 3, remind me",
  "Remind me tonight to check emails",
  "Remind me in the afternoon for yoga",
  "Remind me to drink water in 30 minutes",
  "Remind me on 25/06 to pay rent",
  "Remind me on June 25th for anniversary",
  "Remind me next week Thursday for review",
  "Remind me day after tomorrow for interview",
]) {
  check(`[guardrail] creates: "${m}"`, isCreate(m), "NOT detected as create");
}

// (b) Clean titles (no "Remind me", date words, or stray numbers).
for (const [m, t] of [
  ["Create a reminder for dentist appointment on Friday", "dentist appointment"],
  ["Remind me in 2 hours to check the oven", "check the oven"],
  ["Remind me after 30 minutes to drink water", "drink water"],
  ["Remind me on Monday to submit the report", "submit the report"],
  ["Make sure I remember to call John by evening", "call John"],
  ["Remind me in the afternoon for yoga", "yoga"],
  ["Remind me on 25/06 to pay rent", "pay rent"],
  ["Remind me day after tomorrow for interview", "interview"],
] as const) {
  check(`[guardrail] title "${m}" → "${t}"`, extractTitleFromCreateInput(m) === t, `got "${extractTitleFromCreateInput(m)}"`);
}

// (c) "Friday"/"next Friday" resolve to a Friday in the future (whatever the date).
for (const m of ["meeting on Friday at 5pm", "meeting on next Friday at 5pm"]) {
  const iso = parseDateTimeFromInput(m, TZ);
  check(`[guardrail] "${m}" → a future Friday`, typeof iso === "string" && dowOfIso(iso) === 5 && new Date(iso).getTime() > Date.now(), String(iso));
}

// (d) "in 30 minutes" → today, ~30 min from now (relative, not a fixed time).
{
  const iso = parseDateTimeFromInput("drink water in 30 minutes", TZ);
  const delta = iso ? (new Date(iso).getTime() - Date.now()) / 60000 : -1;
  check("[guardrail] 'in 30 minutes' ≈ now + 30m", delta > 25 && delta < 35, `${Math.round(delta)} min`);
}

// ── Report ──
if (failures === 0) { console.log("✓ ALL PASS"); process.exit(0); }
else { console.error(`\n✗ ${failures} FAILURE(S)`); process.exit(1); }
