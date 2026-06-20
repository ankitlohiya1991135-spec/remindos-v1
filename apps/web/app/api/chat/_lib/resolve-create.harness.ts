/**
 * LIVE harness for the LLM create-resolver. Unlike the deterministic harness,
 * this one HITS THE REAL NIM MODEL — it is the only way to verify that arbitrary,
 * non-enumerated phrasings resolve to correct dates ("LLM interprets").
 *
 * Run (needs the NIM key in env):
 *   NVIDIA_NIM_API_KEY=... NVIDIA_NIM_MODEL=... \
 *     npx tsx apps/web/app/api/chat/_lib/resolve-create.harness.ts
 *
 * Or load it from the web app's env file:
 *   node --env-file=apps/web/.env.local \
 *     --import tsx apps/web/app/api/chat/_lib/resolve-create.harness.ts
 *
 * Eyeball that each resolved date matches the intent. There is no PASS/FAIL
 * assertion because "correct" is a human judgement against the anchor date.
 */

import { resolveCreateWithLLM, analyzeReminderRequest } from "./nim";
import { isValidFutureIsoDate, expandRecurringSeries } from "./datetime";

const TZ = "Asia/Kolkata";

// Deliberately NOT in any regex/alias table — the whole point of the LLM path.
const PHRASINGS = [
  "remind me to pay the jewel loan by the 20th",
  "ping me end of next week about taxes",
  "rent on the first",
  "after lunch tomorrow, call the plumber",
  "dentist the day before my trip starts on the 25th",
  "every other monday, team retro",        // bi-weekly — see how it degrades
  "submit the report two days before month end",
  "water the plants every morning",
  "follow up with Sam first thing next working day",
  "book flights sometime this weekend",
  "gym session tonight",
  "pay electricity bill mid next month",
  "remind me about mom's birthday on the 3rd at noon",
  "stand-up in 45 minutes",
  "renew passport in three weeks",
];

async function main() {
  if (!process.env.NVIDIA_NIM_API_KEY) {
    console.error("⚠ NVIDIA_NIM_API_KEY not set — cannot run the live LLM harness.");
    console.error("  Set it in env (or use --env-file=apps/web/.env.local) and re-run.");
    process.exit(2);
  }
  const nowMs = Date.now();
  console.log(`anchor now = ${new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone: TZ }).format(nowMs)} (${TZ})\n`);

  for (const msg of PHRASINGS) {
    const r = await resolveCreateWithLLM(msg, { timeZone: TZ, nowMs });
    if (!r) {
      console.log(`✗ "${msg}"\n    → null (LLM unavailable / failed)\n`);
      continue;
    }
    const when = r.dueAt
      ? `${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ }).format(new Date(r.dueAt))}` +
        (isValidFutureIsoDate(r.dueAt) ? "" : "  ⚠ NOT A VALID FUTURE DATE (would be rejected)")
      : "(no date)";
    console.log(`• "${msg}"`);
    console.log(`    title="${r.title ?? ""}"  due=${when}  explicitTime=${r.hasExplicitTime}  recurrence=${r.recurrence}\n`);
  }

  // ── Smart analyzer: conditional / range / clarify ──
  console.log("\n===== analyzeReminderRequest (series / clarify) =====\n");
  const reqs = [
    "remind me to revise daily until my exam is over",   // expect clarify (no dates)
    "remind me every morning for the next 5 days to meditate", // expect series
    "remind me every day this week at 9pm to take medicine",   // expect series
    "remind me to call the bank tomorrow at 3pm",        // expect single
  ];
  for (const msg of reqs) {
    const a = await analyzeReminderRequest(msg, { timeZone: TZ, nowMs });
    if (!a) { console.log(`✗ "${msg}" → null\n`); continue; }
    if (a.kind === "clarify") { console.log(`• "${msg}"\n    CLARIFY → "${a.question}"\n`); continue; }
    if (a.kind === "series") {
      const n = expandRecurringSeries(new Date(a.seriesStart).getTime(), new Date(a.seriesEnd).getTime(), a.recurrence).length;
      console.log(`• "${msg}"\n    SERIES → "${a.title}" ${a.recurrence}  ${a.seriesStart} → ${a.seriesEnd}  (${n} reminders)\n`);
      continue;
    }
    console.log(`• "${msg}"\n    SINGLE (delegates to simple flow)\n`);
  }
}

void main();
