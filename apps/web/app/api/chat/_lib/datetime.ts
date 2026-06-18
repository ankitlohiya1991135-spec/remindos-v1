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
    || /\b(morning|afternoon|evening|night)\b/i.test(input)
    || /\bin\s+\d+\s*(hour|hr|minute|min)s?\b/i.test(input);
}

export function hasTodayHint(input: string) {
  return /\btoday\b/i.test(input) || /(^|\s)आज(?=\s|$|[,.!?])/i.test(input);
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

/** "in 2 hours", "in 30 minutes", "in 3 days" → ISO string */
export function parseRelativeOffset(input: string): string | null {
  const match = input.toLowerCase().match(/\bin\s+(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day|week)s?\b/);
  if (!match) return null;
  const amount = parseFloat(match[1]!);
  const unit = match[2]!;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 8760) return null;
  const ms =
    /^(hour|hr)/.test(unit) ? amount * 3_600_000 :
    /^(minute|min)/.test(unit) ? amount * 60_000 :
    /^day/.test(unit) ? amount * 86_400_000 :
    /^week/.test(unit) ? amount * 7 * 86_400_000 : 0;
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
