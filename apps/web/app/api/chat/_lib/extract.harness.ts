/**
 * Harness for resolveReminderForUpdate. Run:
 *   npx tsx apps/web/app/api/chat/_lib/extract.harness.ts
 *
 * Covers the real user phrases that were breaking reschedule/edit/delete.
 */

import { resolveReminderForUpdate } from "./extract";
import type { ReminderItem } from "@repo/reminder";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) { failures++; console.error(`✗ ${name}${extra ? ` — ${extra}` : ""}`); }
  else { console.log(`✓ ${name}`); }
}

function makeReminder(id: string, title: string): ReminderItem {
  return {
    id,
    title,
    dueAt: new Date(Date.now() + 86400000).toISOString(),
    status: "pending",
    priority: 3,
    recurrence: "none",
    domain: undefined,
    notes: undefined,
    linkedTaskId: undefined,
  } as unknown as ReminderItem;
}

const REMINDERS: ReminderItem[] = [
  makeReminder("r1", "Dentist appointment"),
  makeReminder("r2", "Doctor checkup"),
  makeReminder("r3", "Gym"),
  makeReminder("r4", "Standup"),
  makeReminder("r5", "Buy groceries"),
  makeReminder("r6", "Pay electricity bill"),
  makeReminder("r7", "Morning walk"),
];

// ── Single unambiguous matches ────────────────────────────────────────────────

{
  const { match } = resolveReminderForUpdate("dentist", REMINDERS);
  check("dentist → Dentist appointment", match?.id === "r1", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("dentist appointment", REMINDERS);
  check("dentist appointment → Dentist appointment", match?.id === "r1", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("doctor", REMINDERS);
  check("doctor → Doctor checkup", match?.id === "r2", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("doctor appointment", REMINDERS);
  check("doctor appointment → Doctor checkup", match?.id === "r2", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("gym", REMINDERS);
  check("gym → Gym", match?.id === "r3", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("gym reminder", REMINDERS);
  check("gym reminder → Gym", match?.id === "r3", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("standup", REMINDERS);
  check("standup → Standup", match?.id === "r4", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("groceries", REMINDERS);
  check("groceries → Buy groceries", match?.id === "r5", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("electricity bill", REMINDERS);
  check("electricity bill → Pay electricity bill", match?.id === "r6", `got: ${match?.title}`);
}
{
  const { match } = resolveReminderForUpdate("morning walk", REMINDERS);
  check("morning walk → Morning walk", match?.id === "r7", `got: ${match?.title}`);
}

// ── Ambiguous — multiple candidates, no single winner ────────────────────────

{
  const TWO_DOCS: ReminderItem[] = [
    makeReminder("d1", "Doctor appointment"),
    makeReminder("d2", "Doctor checkup"),
    ...REMINDERS.slice(2),
  ];
  const { match, candidates } = resolveReminderForUpdate("doctor", TWO_DOCS);
  check("doctor with two doctor reminders → ambiguous (no match)", match === undefined, `got match: ${match?.title}`);
  check("doctor with two doctor reminders → 2 candidates", candidates.length === 2, `got: ${candidates.length}`);
}

// ── No match — returns empty ──────────────────────────────────────────────────

{
  const { match, candidates } = resolveReminderForUpdate("pilates", REMINDERS);
  check("pilates → no match", match === undefined);
  check("pilates → empty candidates", candidates.length === 0);
}
{
  const { match, candidates } = resolveReminderForUpdate("", REMINDERS);
  check("empty rawTarget → no match", match === undefined);
  check("empty rawTarget → empty candidates", candidates.length === 0);
}

// ── Filler-only rawTarget ─────────────────────────────────────────────────────

{
  const { match, candidates } = resolveReminderForUpdate("reminder", REMINDERS);
  check("filler-only 'reminder' → no match", match === undefined);
  check("filler-only 'reminder' → empty candidates", candidates.length === 0);
}

// ── Exact title match wins ────────────────────────────────────────────────────

{
  const EXACT_REMINDERS: ReminderItem[] = [
    makeReminder("e1", "Gym"),
    makeReminder("e2", "Gym session"),
  ];
  const { match } = resolveReminderForUpdate("Gym", EXACT_REMINDERS);
  check("exact 'Gym' beats 'Gym session'", match?.id === "e1", `got: ${match?.title}`);
}

// ── Prefix match (dent → Dentist) ─────────────────────────────────────────────

{
  const JUST_DENTIST: ReminderItem[] = [makeReminder("p1", "Dentist")];
  const { match } = resolveReminderForUpdate("dent", JUST_DENTIST);
  check("prefix 'dent' → Dentist", match?.id === "p1", `got: ${match?.title}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (failures === 0) {
  console.log(`\nAll tests passed.`);
} else {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
