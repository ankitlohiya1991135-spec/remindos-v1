import { filterToday, getReminderBucket, type LifeDomain, type ReminderItem } from "@repo/reminder";
import { findWeekday } from "./datetime";

export function extractTitleFromCreateInput(input: string) {
  let working = input.trim();

  // Ordered prefix patterns — strip the intent phrase, keep the subject/action after it
  const prefixPatterns: RegExp[] = [
    // General "remind me <in 2 hours / on monday / at 5 / tomorrow> to|about <action>" —
    // non-greedy up to the FIRST to/about, so the whole lead-in (incl. the time
    // phrase) is removed and only the action survives.
    /\bremind me\b.*?\b(to|about)\s+/i,
    /\bremind myself\s+.*?\b(to|about)\s+/i,
    /\b(can|could|please)\s+(you\s+)?remind\s+me\b.*?\b(to|about)\s+/i,
    /\bping\s+me\b.*?\b(to|about)\s+/i,
    /\b(alert|notify)\s+me\b.*?\b(to|about)\s+/i,
    /\bmake sure (?:i|that i)\s+(?:remember|remind)(?:\s+myself)?(?:\s+(?:to|about))?\s+/i,
    /\bmake sure (?:i|that i)\s+/i,
    /^note\s*[:\-—]\s*/i,
    /\bnote (?:this|that|it)? ?down\b[\s:\-—]*/i,
    /\bjot (?:this|that|it)? ?down\b[\s:\-—]*/i,
    /\bdon'?t\s+forget\s+to\s+/i,
    /\bi\s+(need|must|have|should|want)\s+to\s+remember\s+to\s+/i,
    /\bping\s+me\s+(at|about|for|when)\s+/i,
    /\b(alert|notify)\s+me\s+(at|about|for|when|to)\s+/i,
    /\bput\s+(a\s+)?reminder\s+(for|to|about)\s+/i,
    /\bi\s+have\s+(a\s+|an\s+)?/i,
    /\b(याद\s+दिलाना|याद\s+कराना|याद\s+रखना|रिमाइंडर\s+लगाओ)\s+/i,
    // Last-resort lead-ins with no "to" ("remind me, gym at 6").
    /\bremind me\b[\s,]+/i,
  ];

  let stripped = false;
  for (const pattern of prefixPatterns) {
    const match = pattern.exec(working);
    if (match?.index !== undefined) {
      working = working.slice(match.index + match[0].length);
      stripped = true;
      break;
    }
  }

  if (!stripped) {
    working = working
      .replace(
        // Also consumes the trailing "to " so "add a reminder to check X" → "check X"
        // not "to check X". The optional `(?:to\s+)` at the end handles this.
        /^(?:please\s+)?(?:create|add|set|make|schedule|बनाओ|तैयार करो|set karo|करो)\s+(?:(?:a|an|the|my)\s+)?(?:reminder|रिमाइंडर|स्मरणपत्र)?\s*(?:to\s+)?/i,
        "",
      )
      .trim();
  }

  // ── Quoted title early return ────────────────────────────────────────────────
  // If the user wrapped the title in quotes (e.g. add reminder "next payment for URL"),
  // extract it verbatim — this bypasses the keyword-strip pipeline which would otherwise
  // eat "next" (date stop-word) and "for" (preposition stop-word) even when they are
  // legitimate parts of the title.
  working = working.trim();
  if ((working.startsWith('"') || working.startsWith("'")) &&
      (working.endsWith('"') || working.endsWith("'"))) {
    const inner = working.slice(1, -1).trim();
    if (inner) return inner;
  }

  const normalized = working
    .replace(/^(?:called|named|titled)\s+/i, "")
    // Strip "for"/"about" only at the very start of the remaining fragment —
    // e.g. "for gym" → "gym". Stripping them globally was eating titles like
    // "next priority for payment" or "budget plan for next month".
    .replace(/^(for|about)\s+/i, "")
    .replace(/\b(called|named|titled|के लिए|साठी)\b/gi, " ")
    // Full date expressions FIRST — strip month+day as one unit so the day number
    // doesn't survive when the month word alone is removed below ("by jun 20" must
    // not leave a stray "20" in the title).
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/gi, " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, " ")
    // Bare ordinal day-of-month: "on the 20th", "by the 1st", "the 5th".
    .replace(/\b(?:on\s+|by\s+)?the\s+\d{1,2}(?:st|nd|rd|th)\b/gi, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, " ")
    // "by Saturday of this week", "next month", "this weekend" — only when a
    // qualifier precedes the period word, so legit titles like "month end review"
    // (no leading by/of/this/next) are preserved.
    .replace(/\b(?:by\s+|of\s+|end\s+of\s+|this\s+|next\s+|coming\s+|the\s+)+(?:week|month|year|weekend)\b/gi, " ")
    // Strip date/time keywords that are never part of the reminder *title*.
    // NOTE: morning|afternoon|evening|night are intentionally kept here because they
    // ARE valid parts of a title (e.g. "morning standup", "evening walk").
    // Time extraction uses parseTimeFromInput() on the original raw input, so removing
    // them from the title does not affect time resolution.
    // "next/this/coming" are stripped only when they precede a time/day word so that
    // titles like "next priority payment" or "this month's budget" are preserved.
    .replace(
      /\b(next|this|coming)\s+(?=today|tomorrow|tomorow|tommarow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|morning|afternoon|evening|night|noon|midnight)\b/gi,
      " "
    )
    // Time expressions that must be removed BEFORE the generic date-word strip
    // below deletes the word "at"/"by" and orphans the rest ("meeting at 3" must
    // not leave a stray "3"; "call by night" must not keep "night").
    .replace(/\bat\s+\d{1,2}\b(?!\s*[:.]?\d)/gi, " ")
    .replace(/\btonight\b/gi, " ")
    .replace(/\b(by|in)\s+the\s+(morning|afternoon|evening|night)\b/gi, " ")
    .replace(/\bby\s+(morning|afternoon|evening|night|noon|midnight)\b/gi, " ")
    // Relative offsets in every phrasing — removed BEFORE the generic date-word
    // strip below deletes "in"/"within" and orphans the rest ("in next one hour",
    // "in the next hour", "within 2 days", "an hour from now", "half an hour",
    // "a couple of days").
    .replace(/\b(?:a|an)\s+(couple|few|several)\b/gi, "$1")
    .replace(/\bhalf\s+an?\s+(?:hour|day|week)\b/gi, " ")
    .replace(/\b(?:in|after|within|next|coming)\s+(?:the\s+)?(?:next\s+|coming\s+)?(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|couple|few|several)\s*(?:of\s+)?(?:hours?|hrs?|minutes?|mins?|days?|weeks?)\b/gi, " ")
    .replace(/\b(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|couple|few|several)\s*(?:of\s+)?(?:hours?|hrs?|minutes?|mins?|days?|weeks?)\s+(?:from\s+now|later)\b/gi, " ")
    .replace(/\b(?:in|within)\s+(?:the\s+)?(?:next\s+|coming\s+)?(?:hours?|days?|weeks?)\b/gi, " ")
    .replace(/\bfrom\s+now\b/gi, " ")
    .replace(
      /\b(today|tonight|tomorrow|tomorow|tommarow|tmrw|yesterday|day after tomorrow|after tomorrow|आज|कल|उद्या|परसों|परवा|at|on|by|noon|midnight|every|in|बजे|वाजता|वाजले|सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi,
      " "
    )
    .replace(/\b\d+\s*(hour|hr|minute|min|day|week)s?\b/gi, " ")
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s?([ap]\.?m\.?)\b/gi, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // The keyword strip above only removes correctly-spelled weekday names. Catch a
  // leftover misspelled/abbreviated weekday (e.g. "thrusday", "thurs") so it doesn't
  // end up in the title. Alias-only match (no fuzzy) so we never eat a real title word.
  const leftoverWeekday = findWeekday(normalized, false);
  let titled = leftoverWeekday
    ? normalized
        .replace(new RegExp(`\\b(?:every|each|on|this|next|coming)?\\s*${leftoverWeekday.token}\\b`, "i"), " ")
        .replace(/\s+/g, " ")
        .trim()
    : normalized;

  // Final cleanup: drop a dangling trailing connector word and any stray
  // punctuation left behind by stripping ("call santosh ." → "call santosh",
  // "pay the loan by" → "pay the loan").
  titled = titled
    // Trailing ", remind me" ("meeting with the client at 3, remind me" → "meeting with the client").
    .replace(/[\s,]*\b(?:please\s+)?remind me\b\.?\s*$/i, "")
    .replace(/\s*\b(by|on|at|of|for|to)\s*$/i, "")
    // Leading DANGLING time-of-day ("the night for yoga" → "for yoga") — only when
    // followed by a preposition or end, so an adjective+noun title ("evening walk")
    // is preserved.
    .replace(/^\s*(the\s+)?(morning|afternoon|evening|night|tonight)\s+(?=(for|about|to|at|on)\b)/i, "")
    .replace(/^\s*(the\s+)?(morning|afternoon|evening|night|tonight)\s*$/i, "")
    // Leading leftover connector ("for standup" → "standup", "about gym" → "gym").
    .replace(/^\s*(for|about|to)\s+/i, "")
    .replace(/^[\s.,;:!?–—-]+|[\s.,;:!?–—-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Guard: if prefix-stripping failed and the result still reads like an intent command
  // (e.g. "so create the reminder", "go ahead and add reminder"), return undefined
  // so the fast-path uses the DEFAULT title and the LLM can handle context properly.
  if (/\b(create|add|set|make|schedule)\b.{0,40}\b(reminder|reminders)\b/i.test(titled)) {
    return undefined;
  }

  return titled || undefined;
}

// ─── FLAW-2: extract metadata from natural language for deterministic create ──

export function extractPriorityFromInput(input: string): number | undefined {
  const n = input.toLowerCase();
  if (/\b(critical|urgent|asap|immediately)\b/.test(n)) return 5;
  if (/\b(high\s*priority|very\s*important|top\s*priority)\b/.test(n)) return 4;
  if (/\b(important|priority)\b/.test(n)) return 3;
  if (/\b(low\s*priority|whenever|sometime)\b/.test(n)) return 2;
  return undefined;
}

export function extractDomainFromInput(input: string): LifeDomain | undefined {
  const n = input.toLowerCase();
  if (/\bhealth\b/.test(n)) return "health";
  if (/\b(finance|financial|money|bank|budget|invest)\b/.test(n)) return "finance";
  if (/\b(career|work|job|office|meeting|professional)\b/.test(n)) return "career";
  if (/\bhobby\b/.test(n)) return "hobby";
  if (/\b(fun|entertainment|party|vacation)\b/.test(n)) return "fun";
  return undefined;
}

export function extractRecurrenceFromInput(input: string): "daily" | "weekly" | "monthly" | undefined {
  const n = input.toLowerCase();
  if (/\b(every\s*day|everyday|daily|each\s*day)\b/.test(n)) return "daily";
  if (/\b(every\s*week|weekly|each\s*week)\b/.test(n)) return "weekly";
  if (/\b(every\s*month|monthly|each\s*month)\b/.test(n)) return "monthly";
  // "every thursday" / "every thrusday" / "each friday" → recurs weekly on that day.
  if (/\b(every|each)\b/.test(n) && findWeekday(n)) return "weekly";
  return undefined;
}

// ─── Normalised title matching ──────────────────────────────────────────────
// Collapse whitespace, hyphens and underscores so "fix up" ≡ "fixup".
// Used in every fast-path `includes()` check so user phrasing differences
// (e.g. "bathroom door fix up" vs "Bathroom door fixup") don't cause misses.
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]+/g, "");
}

/** True if `rawTarget` appears in `title` under normalised comparison. */
export function titleIncludesTarget(title: string, rawTarget: string): boolean {
  return (
    title.toLowerCase().includes(rawTarget.toLowerCase()) ||
    normalizeForMatch(title).includes(normalizeForMatch(rawTarget))
  );
}

// ─── Gap 2: deterministic target extraction for mark-done / delete ────────────

export function extractTargetFromMarkDone(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(mark|set|flag|put)\s*(it|them|this|that)?\s*/gi, " ")
    .replace(/\b(as\s+)?(done|complete|completed|finished|finish)\b/gi, " ")
    .replace(/\bdone\s+with\b/gi, " ")
    .replace(/\b(i('?ve| have)\s+)?(done|completed|finished)\b/gi, " ")
    .replace(/\bcheck(ed)?\s*off\b/gi, " ")
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTargetFromDelete(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(delete|remove|cancel|dismiss|drop|trash|erase)\s*(it|them|this|that)?\s*/gi, " ")
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTargetFromReschedule(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    // Strip "change/update the time/date/schedule of X" — full command phrase
    .replace(/\b(change|update)\s+the\s+(time|date|due\s+date|due\s+time|schedule)\s*(of|for|on)?\s*/gi, " ")
    // Strip leading action verb when NOT followed by "the" (e.g. "change coding lab date to …",
    // "move meeting to tomorrow", "reschedule gym to …").
    // Using negative lookahead so "change the …" falls through to the previous rule.
    .replace(/^(change|update|reschedule|move|shift)\s+(?!the\s)/i, " ")
    // Strip "date/time to/for/at/of …" — handles "coding lab date to today at 1pm"
    // where the target title comes BEFORE the word "date/time".
    .replace(/\b(date|time)\s+(to|for|at|of)\b.*/gi, " ")
    // Strip "reschedule/move/shift" wherever they still appear
    .replace(/\b(reschedule|move|shift)\s*/gi, " ")
    // Strip everything from the new time onwards: "to today at 5pm", "to 5pm", "for tomorrow"
    .replace(/\b(to|for)\s+(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*/gi, " ")
    .replace(/\bto\s+\d{1,2}(:\d{2})?\s*(am|pm)\b.*/gi, " ")
    // Strip loose date/time words left behind
    .replace(/\b(today|tomorrow|tonight|at|on|by|next|this|coming|morning|evening|afternoon|night|noon|midnight)\b/gi, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi, " ")
    .replace(/\b\d{4}\b/g, " ")                                    // year numbers
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\b/g, " ")                  // day numbers (1st, 2nd, 18, …)
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s?([ap]\.?m\.?)\b/gi, " ")   // times (1pm, 3:30am)
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    // Strip articles and reminder-type words
    .replace(/\b(my|the|a|an|reminder|reminders|for|about|it|that|this)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Gap 4: snooze helpers ────────────────────────────────────────────────────

export const PRONOUN_TARGETS = new Set(["it", "that", "this", "them", "those", "one"]);

/**
 * Words that are extraction artifacts / filler — never a real reminder title.
 * If a target-extraction (e.g. extractTargetFromReschedule) reduces to ONLY
 * these, the user was really referring to context ("change its time …",
 * "move it to …"), so we should resolve from conversation history rather than
 * trying to match a bogus title or falling through to the LLM (which guesses).
 */
export const TARGET_FILLER_WORDS = new Set([
  "its", "it", "the", "a", "an", "my", "to", "for", "of", "on",
  "time", "date", "due", "schedule", "this", "that", "them", "those", "one",
  "reminder", "reminders", "task", "tasks",
]);

/** True when the extracted target contains at least one real (non-filler) word. */
export function targetHasMeaningfulContent(rawTarget: string): boolean {
  return rawTarget
    .toLowerCase()
    .split(/\s+/)
    .some((tok) => tok.length >= 3 && !TARGET_FILLER_WORDS.has(tok));
}

/**
 * Phase 1C — Pronoun resolution.
 * When the user says "reschedule it" / "delete that" / etc., try to identify
 * the reminder being referred to from the most-recent assistant message.
 * The assistant's previous reply almost always contains the reminder title
 * in double-quotes (e.g. `Rescheduled "Buy groceries" to tomorrow.`).
 */
export function resolveTargetFromHistory(
  history: Array<{ role: string; content: string }>,
  reminders: ReminderItem[],
): ReminderItem | undefined {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant?.content) return undefined;

  // 1. Try quoted titles first — most reliable
  const quoted = [...lastAssistant.content.matchAll(/"([^"]{2,80})"/g)].map((m) => m[1]!);
  for (const q of quoted) {
    const match = reminders.find(
      (r) =>
        r.title.toLowerCase() === q.toLowerCase() ||
        r.title.toLowerCase().includes(q.toLowerCase()) ||
        q.toLowerCase().includes(r.title.toLowerCase()),
    );
    if (match) return match;
  }

  // 2. Try reminder titles that appear verbatim in the assistant message
  const body = lastAssistant.content.toLowerCase();
  // Sort longest-first so a more-specific title wins over a shorter substring
  const sorted = [...reminders].sort((a, b) => b.title.length - a.title.length);
  for (const r of sorted) {
    if (r.title.length >= 4 && body.includes(r.title.toLowerCase())) return r;
  }

  return undefined;
}

/** Returns delay in minutes, or null if no duration found in message. */
export function extractSnoozeDelayMinutes(message: string): number | null {
  const n = message.toLowerCase();
  if (/\bhalf\s+an?\s+hour\b/.test(n) || /\bhalf\s+hour\b/.test(n)) return 30;
  if (/\ban?\s+hour\b/.test(n)) return 60;
  if (/\ba\s+few\s+minutes?\b/.test(n)) return 5;
  const match = n.match(/\b(\d+(?:\.\d+)?)\s*(hour|hr|h|minute|min|m)s?\b/);
  if (match) {
    const amount = parseFloat(match[1]!);
    const unit = match[2]!;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1440) return null;
    if (/^(hour|hr|h)/.test(unit)) return Math.round(amount * 60);
    if (/^(minute|min|m)/.test(unit)) return Math.round(amount);
  }
  return null;
}

export function extractTargetFromSnooze(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(snooze|postpone|delay|push|remind me again|remind me later)\s*/gi, " ")
    .replace(/\b(by|for|in|after)\s+\d+\s*(hour|hr|minute|min|h|m)s?\b/gi, " ")
    .replace(/\b(half\s+(an?\s+)?hour|an?\s+hour|a\s+few\s+minutes?)\b/gi, " ")
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Gap 5: edit title/notes helpers ─────────────────────────────────────────

export function extractEditField(message: string): "title" | "notes" | "priority" | "domain" | "recurrence" | "linkedTaskId" | null {
  const n = message.toLowerCase();
  if (/\b(rename|retitle)\b/.test(n)) return "title";
  if (/\b(title|name)\b/.test(n)) return "title";
  if (/\bnotes?\b/.test(n)) return "notes";
  if (/\bpriority\b/.test(n)) return "priority";
  if (/\b(domain|category)\b/.test(n)) return "domain";
  if (/\b(recurrence|recurring|repeat)\b/.test(n)) return "recurrence";
  if (/\b(make|set|change|update)\b.{0,30}\b(daily|weekly|monthly|one.?time|non.?recurring)\b/.test(n)) return "recurrence";
  if (/\bstop\s+(repeating|recurring)\b/.test(n)) return "recurrence";
  if (/\b(link|attach|connect|unlink|delink|detach|disconnect)\b.{0,30}\btask\b/.test(n)) return "linkedTaskId";
  if (/\b(unlink|delink|detach|disconnect)\b.{0,15}\bfrom\b/.test(n)) return "linkedTaskId";
  if (/\bremove\b.{0,20}\btask\b.{0,20}\b(link|connection)\b/.test(n)) return "linkedTaskId";
  // Priority as adjective: "high priority X", "make X urgent"
  if (/\b(high|medium|low|urgent|normal)\s+priority\b/.test(n)) return "priority";
  if (/\b(make|set)\b.{0,20}\b(high|medium|low|urgent|normal)\b/.test(n)) return "priority";
  return null;
}

export function extractNewValueFromEdit(message: string): string | null {
  // Quoted: to "value" or to 'value'
  const quotedTo = message.match(/\bto\s+"([^"]+)"\s*$/i) ?? message.match(/\bto\s+'([^']+)'\s*$/i);
  if (quotedTo?.[1]) return quotedTo[1].trim();
  // Quoted: with "value"
  const quotedWith = message.match(/\bwith\s+"([^"]+)"\s*$/i) ?? message.match(/\bwith\s+'([^']+)'\s*$/i);
  if (quotedWith?.[1]) return quotedWith[1].trim();
  // Unquoted after "to": take rest of string, skip if it looks like a date/time phrase
  const toMatch = message.match(/\bto\s+(.+?)\s*$/i);
  if (toMatch?.[1]) {
    const val = toMatch[1].trim();
    const looksLikeDate = /\b(am|pm|tomorrow|today|tonight|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|noon|midnight|\d{1,2}[:.]\d{2})\b/i.test(val);
    if (!looksLikeDate && val.length >= 2) return val;
  }
  // Unquoted after "with"
  const withMatch = message.match(/\bwith\s+(.+?)\s*$/i);
  if (withMatch?.[1] && withMatch[1].trim().length >= 2) return withMatch[1].trim();
  return null;
}

export function extractTargetFromEdit(message: string): string {
  let working = message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(rename|retitle|change|update|edit|modify)\s*/gi, " ");
  // Strip "the title/name/notes of/for/on"
  working = working.replace(/\b(the\s+)?(title|name|notes?|description)\s+(?:of|for|on|in)\s*/gi, " ");
  working = working.replace(/\b(the\s+)?(title|name|notes?|description)\s*/gi, " ");
  // Strip separator and new value (everything after "to", "with", "as")
  working = working.replace(/\s+to\s+.+$/i, " ");
  working = working.replace(/\s+with\s+.+$/i, " ");
  working = working.replace(/\s+as\s+.+$/i, " ");
  return working
    .replace(/\b(my|the|a|an|reminder|reminders|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract numeric priority (1–5) from phrases like "high priority", "priority 3", "make it urgent" */
export function extractPriorityFromEdit(message: string): number | null {
  const n = message.toLowerCase();
  // Explicit number: "priority 4", "set to 3 stars"
  const numMatch = n.match(/\bpriority\s+(\d)\b/) ?? n.match(/\bto\s+(\d)\s*(?:stars?)?\b/);
  if (numMatch?.[1]) {
    const v = parseInt(numMatch[1], 10);
    if (v >= 1 && v <= 5) return v;
  }
  // Word labels
  if (/\b(urgent|critical|highest|top|5\s*stars?)\b/.test(n)) return 5;
  if (/\b(high|important|4\s*stars?)\b/.test(n)) return 4;
  if (/\b(medium|normal|default|3\s*stars?)\b/.test(n)) return 3;
  if (/\b(low|minor|2\s*stars?)\b/.test(n)) return 2;
  if (/\b(lowest|trivial|none|no\s*priority|1\s*star)\b/.test(n)) return 1;
  return null;
}

/** Extract domain tag from phrases like "domain health", "category finance", "make it a career reminder" */
export function extractDomainFromEdit(message: string): LifeDomain | null | undefined {
  const n = message.toLowerCase();
  // Explicit clear: "clear domain", "remove domain", "no domain", "clear category"
  if (/\b(clear|remove|none|no)\b.{0,15}\b(domain|category)\b/.test(n)) return null;
  if (/\b(health|fitness|medical|exercise|workout)\b/.test(n)) return "health";
  if (/\b(finance|financial|money|budget|investment|saving)\b/.test(n)) return "finance";
  if (/\b(career|work|job|professional|business)\b/.test(n)) return "career";
  if (/\b(hobby|hobbies|personal|leisure|creative)\b/.test(n)) return "hobby";
  if (/\b(fun|entertainment|social|play|game)\b/.test(n)) return "fun";
  return undefined; // not found
}

/** Extract recurrence from phrases like "make it daily", "set recurrence to weekly", "stop repeating" */
export function extractRecurrenceFromEdit(message: string): "none" | "daily" | "weekly" | "monthly" | null {
  const n = message.toLowerCase();
  if (/\b(stop\s+(repeating|recurring)|one.?time|non.?recurring|no\s+recurrence|remove\s+recurrence)\b/.test(n)) return "none";
  if (/\bdaily\b/.test(n)) return "daily";
  if (/\bweekly\b/.test(n)) return "weekly";
  if (/\bmonthly\b/.test(n)) return "monthly";
  return null;
}

/** Extract task link intent: returns { link: true, taskHint } for link, or { link: false } for delink */
export function extractTaskLinkIntent(message: string): { link: false } | { link: true; taskHint: string } | null {
  const n = message.toLowerCase();
  if (/\b(unlink|delink|detach|disconnect)\b/.test(n) || /\bremove\b.{0,20}\btask\b.{0,20}\b(link|connection)\b/.test(n)) {
    return { link: false };
  }
  if (/\b(link|attach|connect)\b/.test(n)) {
    // Try to extract task name hint from "to task X", "with task X", "to X task"
    const m = message.match(/\b(?:to|with)\s+(?:task\s+)?["']?([A-Za-z0-9 _-]{2,50})["']?/i);
    return { link: true, taskHint: m?.[1]?.trim() ?? "" };
  }
  return null;
}

// ─── Gap 6: bulk helpers ──────────────────────────────────────────────────────

export function extractBulkOperation(message: string): "mark_done" | "delete" | null {
  const n = message.toLowerCase();
  if (/\b(delete|remove|cancel|dismiss|trash|erase)\b/.test(n)) return "delete";
  if (/\b(mark|set|flag)\b.{0,25}\b(done|complete|completed|finished)\b/.test(n)) return "mark_done";
  if (/\b(complete|finish)\b/.test(n)) return "mark_done";
  return null;
}

export function extractBulkTargets(message: string, reminders: ReminderItem[], timeZone?: string): ReminderItem[] {
  const n = message.toLowerCase();
  const now = new Date();
  const sortByDue = (a: ReminderItem, b: ReminderItem) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  const pending = reminders.filter((r) => r.status === "pending");

  if (/\b(missed|overdue)\b/.test(n)) {
    return pending.filter((r) => new Date(r.dueAt).getTime() < now.getTime()).sort(sortByDue);
  }
  if (/\btoday\b/.test(n)) return filterToday(pending, now, timeZone);
  if (/\btomorrow\b/.test(n)) {
    return pending.filter((r) => getReminderBucket(r, now, timeZone) === "tomorrow").sort(sortByDue);
  }
  // Domain filters
  const DOMAIN_PATTERNS: [RegExp, LifeDomain][] = [
    [/\bhealth\b/, "health"],
    [/\b(finance|financial|money)\b/, "finance"],
    [/\b(career|work|job)\b/, "career"],
    [/\bhobby\b/, "hobby"],
    [/\b(fun|entertainment)\b/, "fun"],
  ];
  for (const [pattern, domain] of DOMAIN_PATTERNS) {
    if (pattern.test(n)) return pending.filter((r) => r.domain === domain).sort(sortByDue);
  }
  // Fix: if no scope keyword matched, return [] rather than ALL reminders —
  // prevents "complete every appointment" from bulk-targeting the entire account.
  return [];
}

// ─── Gap 7: multi-turn ordinal resolution ────────────────────────────────────

export function extractOrdinalIndex(message: string): number | null {
  const n = message.toLowerCase();
  if (/\b(first|1st)\b/.test(n)) return 0;
  if (/\b(second|2nd)\b/.test(n)) return 1;
  if (/\b(third|3rd)\b/.test(n)) return 2;
  if (/\b(fourth|4th)\b/.test(n)) return 3;
  if (/\b(fifth|5th)\b/.test(n)) return 4;
  if (/\blast\b/.test(n)) return -1; // -1 = last index
  return null;
}

/** Resolve "the first one / the last one" against the last listed set. Returns null if no match. */
export function resolveByOrdinal(
  message: string,
  reminders: ReminderItem[],
  recentListedIds: string[] | undefined,
): ReminderItem | null {
  if (!recentListedIds?.length) return null;
  const ordinal = extractOrdinalIndex(message);
  if (ordinal === null) return null;
  const idx = ordinal === -1 ? recentListedIds.length - 1 : ordinal;
  const id = recentListedIds[idx];
  if (!id) return null;
  return reminders.find((r) => r.id === id && r.status === "pending") ?? null;
}

// ─── Task CRUD helpers ────────────────────────────────────────────────────────

/** True if the message is about tasks at all — required before any task classifier. */
export function taskGate(m: string): boolean {
  return /\btasks?\b/i.test(m);
}

export function looksLikeCreateTaskIntent(m: string): boolean {
  const n = m.toLowerCase();
  return (
    /\b(create|add|make|new)\b.{0,40}\btasks?\b/.test(n) ||
    /\btasks?\b.{0,30}\b(create|add|make|new)\b/.test(n)
  );
}

export function looksLikeListTasksIntent(m: string): boolean {
  const n = m.toLowerCase().trim();
  return (
    /\b(show|list|see|what|which|display|view)\b.{0,30}\btasks?\b/.test(n) ||
    /\btasks?\b.{0,20}\b(show|list|see|what)\b/.test(n) ||
    /^(my\s+)?tasks?\s*\??\s*$/.test(n)
  );
}

export function looksLikeMarkTaskDoneIntent(m: string): boolean {
  const n = m.toLowerCase();
  return (
    /\b(mark|complete|finish|done|completed|finished|checked\s+off)\b.{0,40}\btasks?\b/.test(n) ||
    /\btasks?\b.{0,40}\b(mark|complete|finish|done|completed|finished)\b/.test(n) ||
    /\b(i'?ve?\s+)?(done|finished|completed)\b.{0,30}\btasks?\b/.test(n)
  );
}

export function looksLikeDeleteTaskIntent(m: string): boolean {
  const n = m.toLowerCase();
  return (
    /\b(delete|remove|cancel|drop|trash|erase)\b.{0,40}\btasks?\b/.test(n) ||
    /\btasks?\b.{0,40}\b(delete|remove|cancel|drop|trash)\b/.test(n)
  );
}

export function looksLikeEditTaskIntent(m: string): boolean {
  const n = m.toLowerCase();
  return (
    /\b(rename|retitle|edit|update|change|modify)\b.{0,40}\btasks?\b/.test(n) ||
    /\btasks?\b.{0,40}\b(rename|retitle|edit|update|change|modify)\b/.test(n) ||
    /\b(set|add)\b.{0,20}\b(priority|notes?|domain|category)\b.{0,30}\btasks?\b/.test(n) ||
    /\btasks?\b.{0,30}\b(priority|notes?|domain|category)\b/.test(n)
  );
}

/** Strip task-CRUD verbs to leave just the task title. */
export function extractTargetFromTaskMessage(message: string): string {
  return message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(create|add|make|new|delete|remove|cancel|drop|trash|erase|mark|complete|finish|done|completed|finished|checked\s+off)\s*/gi, " ")
    .replace(/\b(my|the|a|an|task|tasks|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip edit verbs and the new value to leave just the task title. */
export function extractTargetFromTaskEdit(message: string): string {
  let working = message
    .replace(/^(please\s+)?/i, "")
    .replace(/\b(rename|retitle|change|update|edit|modify)\s*/gi, " ");
  working = working.replace(/\b(the\s+)?(title|name|notes?|description|priority|domain|category)\s+(?:of|for|on|in)\s*/gi, " ");
  working = working.replace(/\b(the\s+)?(title|name|notes?|description|priority|domain|category)\s*/gi, " ");
  working = working.replace(/\s+to\s+.+$/i, " ");
  working = working.replace(/\s+with\s+.+$/i, " ");
  working = working.replace(/\s+as\s+.+$/i, " ");
  return working
    .replace(/\b(my|the|a|an|task|tasks|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Which field does this edit-task message target? (title, notes, priority, domain) */
export function extractEditTaskField(message: string): "title" | "notes" | "priority" | "domain" | null {
  const n = message.toLowerCase();
  if (/\b(rename|retitle)\b/.test(n)) return "title";
  if (/\b(title|name)\b/.test(n)) return "title";
  if (/\bnotes?\b/.test(n)) return "notes";
  if (/\bpriority\b/.test(n)) return "priority";
  if (/\b(domain|category)\b/.test(n)) return "domain";
  if (/\b(high|medium|low|urgent|normal)\s+priority\b/.test(n)) return "priority";
  if (/\b(make|set)\b.{0,20}\b(high|medium|low|urgent|normal)\b/.test(n)) return "priority";
  return null;
}

/** Extract a clean task title from a "create task <title>" message. */
export function extractTitleFromTaskInput(message: string): string | undefined {
  let working = message.trim();
  // Remove "create/add/make/new [a/the] task" prefix
  working = working
    .replace(/^(?:please\s+)?(?:create|add|make|new)\s+(?:(?:a|an|the|my)\s+)?tasks?\s*/i, "")
    .trim();
  working = working.replace(/^(?:called|named|titled)\s+/i, "");
  // Remove trailing filler words
  working = working
    .replace(/\b(for|about|called|named|titled)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return working || undefined;
}
