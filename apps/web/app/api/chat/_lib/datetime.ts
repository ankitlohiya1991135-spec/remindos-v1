// ─── Date / time parsing ──────────────────────────────────────────────────────

export function hasExplicitTime(input: string) {
  const normalized = input
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/([ap])\.\s?m\.(?!\w)/gi, "$1m");
  return /\b(\d{1,2})(?:[:.]\d{2})?\s?(am|pm)\b/i.test(normalized)
    || /\b\d{1,2}[:.]\d{2}\b/.test(input)
    || /(?:^|\s)\d{1,2}\s*(?:बजे|वाजता|वाजले)(?=\s|$|[,.!?])/i.test(normalized)
    || /(?:^|\s)(सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात)(?=\s|$|[,.!?])/i.test(normalized)
    || /\b(noon|midnight)\b/i.test(input)
    || /\b(morning|afternoon|evening|night|tonight)\b/i.test(input)
    || /\bat\s+\d{1,2}\b(?!\s*[:.]?\d)/i.test(input)
    // Any relative offset ("in 2 hours", "in next one hour", "an hour from now",
    // "half an hour") counts as an explicit time → create now, never ask "when?".
    || parseRelativeOffset(input) !== null;
}

export function hasTodayHint(input: string) {
  return /\b(today|tonight)\b/i.test(input) || /(^|\s)आज(?=\s|$|[,.!?])/i.test(input);
}

export function hasTomorrowHint(input: string) {
  return /\b(tomorrow|tomorow|tommarow|tmrw)\b/i.test(input)
    || /(^|\s)(कल|उद्या)(?=\s|$|[,.!?])/i.test(input);
}

export function hasDayAfterTomorrowHint(input: string) {
  return /\b(day after tomorrow|after tomorrow)\b/i.test(input)
    || /(^|\s)(परसों|परवा)(?=\s|$|[,.!?])/i.test(input);
}

export function parseTimeFromInput(input: string) {
  const normalized = input
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/([ap])\.\s?m\.(?!\w)/gi, "$1m");

  const meridiemMatch = normalized.match(/\b(\d{1,2})(?:[:.]\s*(\d{2}))?\s?(am|pm)\b/i);
  if (meridiemMatch) {
    const rawHour = Number.parseInt(meridiemMatch[1] ?? "0", 10);
    const minute = Number.parseInt(meridiemMatch[2] ?? "0", 10);
    if (!Number.isFinite(rawHour) || rawHour < 1 || rawHour > 12) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    const meridiem = (meridiemMatch[3] ?? "am").toLowerCase();
    let hour = rawHour % 12;
    if (meridiem === "pm") hour += 12;
    return { hour, minute };
  }

  const clockMatch = input.match(/\b(\d{1,2})[:.]\s*(\d{2})\b/);
  if (clockMatch) {
    const hour = Number.parseInt(clockMatch[1] ?? "0", 10);
    const minute = Number.parseInt(clockMatch[2] ?? "0", 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }

  // Bare hour after "at" with no am/pm ("meeting at 3", "standup at 9"). Checked
  // BEFORE the regional matcher (which would otherwise grab the lone digit and
  // bail). Ambiguous, so pick the most likely: 1–6 → afternoon/evening (PM),
  // 7–12 → as-is (AM / noon). The user can adjust on the editable card.
  const bareHour = input.match(/\bat\s+(\d{1,2})\b(?!\s*[:.]?\d)/i);
  if (bareHour) {
    let h = Number.parseInt(bareHour[1] ?? "-1", 10);
    if (h >= 1 && h <= 12) {
      if (h >= 1 && h <= 6) h += 12;
      return { hour: h, minute: 0 };
    }
  }

  const regionalMatch = normalized.match(
    /(?:^|\s)(\d{1,2})(?:[:.]\s*(\d{2}))?\s*(?:बजे|वाजता|वाजले)?\s*(सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात)?(?=\s|$|[,.!?])/i,
  );
  if (regionalMatch) {
    const rawHour = Number.parseInt(regionalMatch[1] ?? "-1", 10);
    const minute = Number.parseInt(regionalMatch[2] ?? "0", 10);
    if (!Number.isFinite(rawHour) || rawHour < 0 || rawHour > 23) return null;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    const part = (regionalMatch[3] ?? "").toLowerCase();
    if (!part && !/(?:बजे|वाजता|वाजले)/i.test(normalized)) return null;
    let hour = rawHour;
    if (part) {
      if (/सुबह|सकाळी/i.test(part)) { if (hour === 12) hour = 0; }
      else if (/दोपहर|दुपारी/i.test(part)) { if (hour >= 1 && hour <= 11) hour += 12; }
      else if (/शाम|सायंकाळी|रात/i.test(part)) { if (hour >= 1 && hour <= 11) hour += 12; }
    }
    return { hour, minute };
  }

  if (/\bnoon\b/i.test(input)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/i.test(input)) return { hour: 0, minute: 0 };
  if (/(?:^|\s)(दोपहर|दुपारी)(?=\s|$|[,.!?])/i.test(normalized)) return { hour: 12, minute: 0 };
  if (/(?:^|\s)(आधी रात|मध्यरात्र)(?=\s|$|[,.!?])/i.test(normalized)) return { hour: 0, minute: 0 };
  if (/\btonight\b/i.test(input)) return { hour: 21, minute: 0 };
  if (/\bmorning\b/i.test(input)) return { hour: 9, minute: 0 };
  if (/\bafternoon\b/i.test(input)) return { hour: 14, minute: 0 };
  if (/\bevening\b/i.test(input)) return { hour: 19, minute: 0 };
  if (/\bnight\b/i.test(input)) return { hour: 21, minute: 0 };
  return null;
}

export function getCalendarDateInTimeZone(date: Date, timeZone?: string) {
  if (!timeZone) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>;
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

export function addDaysToCalendarDate(value: { year: number; month: number; day: number }, days: number) {
  const utc = new Date(Date.UTC(value.year, value.month - 1, value.day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>;
  const zonedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return (zonedAsUtc - date.getTime()) / 60000;
}

export function calendarDateTimeToIso(
  calendar: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timeZone?: string,
) {
  if (!timeZone) {
    const date = new Date();
    date.setHours(time.hour, time.minute, 0, 0);
    date.setFullYear(calendar.year, calendar.month - 1, calendar.day);
    return date.toISOString();
  }
  const utcGuess = Date.UTC(calendar.year, calendar.month - 1, calendar.day, time.hour, time.minute, 0, 0);
  const firstOffset = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  let utcInstant = utcGuess - firstOffset * 60_000;
  const secondOffset = getTimeZoneOffsetMinutes(new Date(utcInstant), timeZone);
  if (secondOffset !== firstOffset) utcInstant = utcGuess - secondOffset * 60_000;
  return new Date(utcInstant).toISOString();
}

// ─── Extended date parsers ─────────────────────────────────────────────────────

export const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const MONTH_MAP: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

// Common abbreviations + frequent misspellings → weekday index (0 = Sunday).
// A curated alias map keeps matching deterministic and false-positive-free; the
// Optimal-String-Alignment fallback in findWeekday() then catches any single-typo
// variant we didn't enumerate (e.g. an adjacent transposition like "thrusday").
export const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0, suday: 0, sundey: 0, sundy: 0,
  mon: 1, monday: 1, munday: 1, monaday: 1, mondey: 1, mondy: 1,
  tue: 2, tues: 2, tuesday: 2, tuesaday: 2, tuesfay: 2, tusday: 2, teusday: 2, tuseday: 2, tuesdy: 2,
  wed: 3, weds: 3, wednesday: 3, wensday: 3, wednsday: 3, wedneday: 3, wendsday: 3, wenesday: 3, wednesdy: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thrusday: 4, thursaday: 4, thusday: 4, thurday: 4, thrsday: 4, thursdy: 4, thursdey: 4,
  fri: 5, friday: 5, fryday: 5, friaday: 5, fridey: 5, fridy: 5,
  sat: 6, saturday: 6, saterday: 6, satuday: 6, satrday: 6, saturdy: 6, saturaday: 6,
};

/** Optimal String Alignment distance — Levenshtein + adjacent transposition (the #1 typo class). */
function osaDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[m]![n]!;
}

/**
 * Find a weekday mentioned anywhere in free text. Tries the exact alias map first
 * (deterministic, no false positives), then — when `fuzzy` — a single-edit OSA
 * match against the full weekday names (length-guarded to ≥6 chars so it can't
 * swallow short words). Returns the weekday index (0–6) and the matched token.
 */
export function findWeekday(text: string, fuzzy = true): { index: number; token: string } | null {
  const tokens = text.toLowerCase().match(/[a-z]+/g);
  if (!tokens) return null;
  for (const tok of tokens) {
    if (tok in WEEKDAY_ALIASES) return { index: WEEKDAY_ALIASES[tok]!, token: tok };
  }
  if (fuzzy) {
    for (const tok of tokens) {
      if (tok.length < 6) continue;
      for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
        if (osaDistance(tok, WEEKDAY_NAMES[i]!) <= 1) return { index: i, token: tok };
      }
    }
  }
  return null;
}

/** "next Friday", "this Monday", "on Thursday", "every thrusday" → calendar date in user's timezone */
export function parseWeekdayTarget(input: string, timeZone?: string): string | null {
  const match = findWeekday(input);
  if (!match) return null;

  const time = parseTimeFromInput(input);
  if (!time) return null;

  const now = new Date();
  const today = getCalendarDateInTimeZone(now, timeZone);
  const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const currentWeekday = todayUtc.getUTCDay();

  // Resolve to the next upcoming occurrence of that weekday (never today). This is
  // the right behaviour for "on thursday" / "this thursday" / "next thursday" and
  // for the first fire of a recurring "every thursday" alike.
  let daysUntil = match.index - currentWeekday;
  if (daysUntil <= 0) daysUntil += 7;

  const targetDay = addDaysToCalendarDate(today, daysUntil);
  return calendarDateTimeToIso(targetDay, time, timeZone);
}

// Word → number for relative offsets ("in next one hour", "half an hour", "couple of days").
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  half: 0.5, couple: 2, few: 3, several: 3,
};
const NUM = "(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|couple|few|several)";
const UNIT = "(hours?|hrs?|minutes?|mins?|days?|weeks?)";
function numVal(w: string): number {
  return /^\d/.test(w) ? parseFloat(w) : (NUM_WORDS[w] ?? NaN);
}
function unitMs(unit: string): number {
  if (/^(hour|hr)/.test(unit)) return 3_600_000;
  if (/^(minute|min)/.test(unit)) return 60_000;
  if (/^day/.test(unit)) return 86_400_000;
  if (/^week/.test(unit)) return 7 * 86_400_000;
  return 0;
}

/**
 * Resolve ANY "N units from now" phrasing → an absolute ISO timestamp. Handles
 * digits AND words, and the many ways people say it: "in 2 hours", "after 30
 * minutes", "in next one hour", "within the next 2 days", "an hour from now",
 * "3 days later", "half an hour", "couple of hours". This is always TODAY-anchored
 * (now + offset) so the system never has to ask "when?" for a relative time.
 */
export function parseRelativeOffset(input: string): string | null {
  // "a couple/few/several of X" → drop the article so "couple"=2 etc. is the number.
  const n = input.toLowerCase().replace(/\b(?:a|an)\s+(couple|few|several)\b/g, "$1");
  const lead = "(?:in|after|within)\\s+(?:the\\s+)?(?:next\\s+|coming\\s+)?";

  // "half an hour/day" → 0.5
  let m = n.match(new RegExp(`\\bhalf\\s+an?\\s+(hour|day|week)\\b`));
  if (m) {
    const ms = 0.5 * unitMs(m[1]!);
    return ms ? new Date(Date.now() + ms).toISOString() : null;
  }

  let amount = NaN;
  let unit = "";
  // in/after/within (the/next/coming) NUM (of) UNIT  — "in next one hour", "within 2 days"
  m = n.match(new RegExp(`\\b${lead}${NUM}\\s*(?:of\\s+)?${UNIT}\\b`));
  if (m) { amount = numVal(m[1]!); unit = m[2]!; }
  // next/coming NUM UNIT  — "next 2 hours", "coming one week"
  if (!m) { m = n.match(new RegExp(`\\b(?:next|coming)\\s+${NUM}\\s*${UNIT}\\b`)); if (m) { amount = numVal(m[1]!); unit = m[2]!; } }
  // NUM UNIT from now / later  — "3 days from now", "an hour later"
  if (!m) { m = n.match(new RegExp(`\\b${NUM}\\s*${UNIT}\\s+(?:from\\s+now|later)\\b`)); if (m) { amount = numVal(m[1]!); unit = m[2]!; } }
  // in/within (the/next/coming) UNIT  — no number → 1 ("in the next hour", "within the hour")
  if (!m) { m = n.match(new RegExp(`\\b(?:in|within)\\s+(?:the\\s+)?(?:next\\s+|coming\\s+)?${UNIT}\\b`)); if (m) { amount = 1; unit = m[1]!; } }

  if (!Number.isFinite(amount) || amount <= 0 || amount > 8760) return null;
  const ms = amount * unitMs(unit);
  if (!ms) return null;
  return new Date(Date.now() + ms).toISOString();
}

/** "May 15", "June 5th", "15 April", "5/15" → ISO string in user's timezone */
export function parseAbsoluteDate(input: string, timeZone?: string): string | null {
  const n = input.toLowerCase();

  for (const [monthName, monthNum] of Object.entries(MONTH_MAP)) {
    // Skip "may" as standalone word — too ambiguous ("may I", "you may")
    if (monthName === "may" && !new RegExp(`\\bmay\\s+\\d`).test(n) && !new RegExp(`\\b\\d.*\\bmay\\b`).test(n)) continue;
    const p1 = new RegExp(`\\b${monthName}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`);
    const p2 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthName}\\b`);
    const m1 = p1.exec(n);
    const m2 = m1 ? null : p2.exec(n);
    const dayStr = m1?.[1] ?? m2?.[1];
    if (!dayStr) continue;
    const dayNum = parseInt(dayStr, 10);
    if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) continue;
    const time = parseTimeFromInput(input);
    if (!time) return null;
    const now = new Date();
    const today = getCalendarDateInTimeZone(now, timeZone);
    let year = today.year;
    if (Date.UTC(year, monthNum - 1, dayNum, time.hour, time.minute) <= now.getTime()) year++;
    return calendarDateTimeToIso({ year, month: monthNum, day: dayNum }, time, timeZone);
  }

  // Numeric MM/DD or MM-DD
  const numMatch = n.match(/\b(1[0-2]|0?[1-9])[\/\-](3[01]|[12]\d|0?[1-9])(?!\d)\b/);
  if (numMatch) {
    const monthNum = parseInt(numMatch[1]!, 10);
    const dayNum = parseInt(numMatch[2]!, 10);
    const time = parseTimeFromInput(input);
    if (!time) return null;
    const now = new Date();
    const today = getCalendarDateInTimeZone(now, timeZone);
    let year = today.year;
    if (Date.UTC(year, monthNum - 1, dayNum, time.hour, time.minute) <= now.getTime()) year++;
    return calendarDateTimeToIso({ year, month: monthNum, day: dayNum }, time, timeZone);
  }

  return null;
}

/**
 * Resolve an explicit CALENDAR DATE from text — weekday ("saturday"), month+day
 * ("jun 20", "20 june"), or numeric ("6/20") — ignoring any time. Returns the
 * {year, month, day} or null if no date is present.
 *
 * This exists so a "date but no time" message ("pay the loan by jun 20") keeps
 * the user's date and only the *time* gets suggested — instead of the whole date
 * being discarded and defaulted to tomorrow.
 */
export function parseCalendarDateFromInput(
  input: string,
  timeZone?: string,
): { year: number; month: number; day: number } | null {
  const today = getCalendarDateInTimeZone(new Date(), timeZone);

  // 1. Weekday (typo-tolerant) → next upcoming occurrence.
  const wd = findWeekday(input);
  if (wd) {
    const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
    let daysUntil = wd.index - todayUtc.getUTCDay();
    if (daysUntil <= 0) daysUntil += 7;
    return addDaysToCalendarDate(today, daysUntil);
  }

  const n = input.toLowerCase();
  const rollYear = (monthNum: number, dayNum: number) => {
    let year = today.year;
    // If that month/day has already passed this year, assume next year.
    if (Date.UTC(year, monthNum - 1, dayNum) < Date.UTC(today.year, today.month - 1, today.day)) {
      year++;
    }
    return { year, month: monthNum, day: dayNum };
  };

  // 2. Named month + day ("jun 20", "june 20th", "20 jun").
  for (const [monthName, monthNum] of Object.entries(MONTH_MAP)) {
    if (monthName === "may" && !/\bmay\s+\d/.test(n) && !/\b\d.*\bmay\b/.test(n)) continue;
    const m1 = new RegExp(`\\b${monthName}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(n);
    const m2 = m1 ? null : new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthName}\\b`).exec(n);
    const dayStr = m1?.[1] ?? m2?.[1];
    if (!dayStr) continue;
    const dayNum = parseInt(dayStr, 10);
    if (dayNum < 1 || dayNum > 31) continue;
    return rollYear(monthNum, dayNum);
  }

  // 3. Numeric MM/DD or MM-DD.
  const numMatch = n.match(/\b(1[0-2]|0?[1-9])[\/\-](3[01]|[12]\d|0?[1-9])(?!\d)\b/);
  if (numMatch) {
    return rollYear(parseInt(numMatch[1]!, 10), parseInt(numMatch[2]!, 10));
  }

  // 4. Bare ordinal day-of-month ("the 20th", "on the 1st", "by the 5th") → that
  //    day this month, or next month if it has already passed.
  const ord = n.match(/\b(?:on\s+|by\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ord) {
    const dayNum = parseInt(ord[1]!, 10);
    if (dayNum >= 1 && dayNum <= 31) {
      let year = today.year;
      let month = today.month;
      if (dayNum < today.day) {
        month++;
        if (month > 12) { month = 1; year++; }
      }
      return { year, month, day: dayNum };
    }
  }

  return null;
}

export function parseDateTimeFromInput(input: string, timeZone?: string) {
  const now = new Date();
  // "from 6 PM to 7 PM" / "from Monday to Friday" — strip the source half so
  // the parser resolves the DESTINATION (what the user wants), not the source.
  // Only strip when both sides look like times/dates, not for "from now on".
  const fromToTimeMatch = input.match(
    /\bfrom\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b.*?\bto\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b.*)/i,
  );
  if (fromToTimeMatch) {
    input = input.replace(
      /\bfrom\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/i, " ",
    );
  }
  let day = getCalendarDateInTimeZone(now, timeZone);
  if (hasDayAfterTomorrowHint(input)) {
    day = addDaysToCalendarDate(day, 2);
  } else if (hasTomorrowHint(input)) {
    day = addDaysToCalendarDate(day, 1);
  } else if (hasTodayHint(input)) {
    // no change
  } else {
    // Extended: weekday / relative offset / absolute date
    const weekdayResult = parseWeekdayTarget(input, timeZone);
    if (weekdayResult) return weekdayResult;
    const relativeResult = parseRelativeOffset(input);
    if (relativeResult) return relativeResult;
    const absoluteResult = parseAbsoluteDate(input, timeZone);
    if (absoluteResult) return absoluteResult;

    // No date hint at all — try time-only.
    // If the extracted time is still in the future TODAY, use today (the natural expectation
    // when a user says "remind me at 3pm" mid-afternoon). If the time has already passed,
    // schedule for tomorrow so the reminder is always in the future.
    const timeOnly = parseTimeFromInput(input);
    if (timeOnly) {
      const todayIso = calendarDateTimeToIso(day, timeOnly, timeZone);
      if (todayIso && new Date(todayIso).getTime() >= Date.now() - 60_000) {
        return todayIso; // still in the future today
      }
      // time already passed — bump to tomorrow
      return calendarDateTimeToIso(addDaysToCalendarDate(day, 1), timeOnly, timeZone);
    }
    return null;
  }
  const time = parseTimeFromInput(input);
  if (!time) return null;
  const iso = calendarDateTimeToIso(day, time, timeZone);
  // If the user said "today at X" but X has already passed, schedule for tomorrow
  // at the exact same time the user specified — don't silently change the time.
  if (iso && hasTodayHint(input) && new Date(iso).getTime() < Date.now() - 60_000) {
    return calendarDateTimeToIso(addDaysToCalendarDate(day, 1), time, timeZone);
  }
  return iso;
}

export function isValidFutureIsoDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() - 60 * 1000;
}

/**
 * Expand a bounded recurring request ("daily until my exam ends", "every day this
 * week at 8am") into a concrete list of dueAt timestamps — one reminder per
 * occurrence. We PRE-GENERATE the series so each row fires on the existing
 * due-notification cron (no new recurring-fire infra needed).
 *
 * `startMs` is the first occurrence (already at the right clock time), `endMs` the
 * inclusive end of the window. Capped so an open-ended request can't create
 * thousands of rows.
 */
/**
 * Parse a CUSTOM interval ("every 3 days", "every other day", "every 2 weeks").
 * Returns the step in days, or null if it's a plain daily/weekly/monthly (handled
 * elsewhere) or not an interval at all.
 */
export function parseEveryInterval(input: string): { stepDays: number } | null {
  const n = input.toLowerCase();
  if (/\bevery\s+(other|alternate)\s+day\b/.test(n)) return { stepDays: 2 };
  const WORD: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const m = n.match(/\bevery\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\s*(day|week|month)s?\b/);
  if (!m) return null;
  const k = /^\d/.test(m[1]!) ? parseInt(m[1]!, 10) : (WORD[m[1]!] ?? 0);
  if (k < 1) return null;
  if (k === 1) return null; // "every 1 day" == daily → let the normal recurrence handle it
  const unit = m[2]!;
  return { stepDays: unit === "week" ? k * 7 : unit === "month" ? k * 30 : k };
}

/** Every explicit clock time in a message ("8 AM and 8 PM" → [{8,0},{20,0}]). */
export function extractClockTimes(input: string): { hour: number; minute: number }[] {
  const out: { hour: number; minute: number }[] = [];
  const re = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const raw = parseInt(m[1]!, 10);
    if (raw < 1 || raw > 12) continue;
    let h = raw % 12;
    if (/p/i.test(m[3]!)) h += 12;
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (min >= 0 && min <= 59) out.push({ hour: h, minute: min });
  }
  return out;
}

/** Step a start timestamp forward by a fixed number of days, capped. */
export function expandByDays(startMs: number, stepDays: number, count: number, cap = 30): number[] {
  const out: number[] = [];
  const n = Math.min(count, cap);
  for (let i = 0; i < n; i++) out.push(startMs + i * stepDays * 86_400_000);
  return out;
}

export function expandRecurringSeries(
  startMs: number,
  endMs: number,
  recurrence: "daily" | "weekly" | "monthly",
  cap = 60,
): number[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const out: number[] = [];
  let cur = startMs;
  let guard = 0;
  while (cur <= endMs && out.length < cap && guard < 5000) {
    out.push(cur);
    if (recurrence === "daily") cur += 86_400_000;
    else if (recurrence === "weekly") cur += 7 * 86_400_000;
    else {
      const d = new Date(cur);
      d.setUTCMonth(d.getUTCMonth() + 1);
      cur = d.getTime();
    }
    guard++;
  }
  return out;
}
