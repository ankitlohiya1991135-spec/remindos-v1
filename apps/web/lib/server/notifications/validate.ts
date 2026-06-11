/**
 * Anti-surveillance validation layer.
 *
 * The notification philosophy for neurodivergent / ADHD users is "fragrant
 * garden, not iron cage": notifications must read like a supportive friend,
 * never a manager watching them. ADHD users experience Rejection Sensitive
 * Dysphoria (RSD) — a single guilt-inducing notification can cause an uninstall.
 *
 * This module is the BACKSTOP: a pure, deterministic filter that blocks copy
 * containing forbidden patterns (guilt, shame, streak threats, FOMO, fake
 * urgency, absence-shaming, commercial nags). It catches *lexical* violations —
 * it is not a tone fixer. The real fix is writing kind copy; this layer stops
 * regressions and neuters the legacy guilt templates on their way out.
 *
 * Usage: gate every outbound notification through `safeNotification(title, body)`.
 */

interface ForbiddenRule {
  /** What this rule guards against (for logging / tests). */
  label: string;
  pattern: RegExp;
}

// ── Forbidden patterns ─────────────────────────────────────────────────────────
// Grouped by violation class. Keep patterns specific enough to avoid false
// positives on legitimate kind copy (e.g. we celebrate streaks, we just never
// threaten them).
const FORBIDDEN: ForbiddenRule[] = [
  // ── Direct absence / inactivity shaming ──
  { label: "you-havent", pattern: /\byou\s*(haven'?t|have not)\b/i },
  { label: "you-forgot", pattern: /\byou\s*forgot\b/i },
  { label: "youve-been-inactive", pattern: /\byou'?ve been (inactive|gone|away)\b/i },
  { label: "dont-forget", pattern: /\bdon'?t forget\b/i },
  { label: "absence-day-count", pattern: /\bday\s*\d+\s*(without|since)\b/i },
  { label: "long-time-no-see", pattern: /\b(long time no see|haven'?t seen you|where('?ve| have) you been)\b/i },
  { label: "miss-you", pattern: /\bmiss(es)?\s*(you|us)\b/i },
  { label: "we-miss-you", pattern: /\bwe miss you\b/i },
  { label: "lonely", pattern: /\blonel(y|iness)\b/i },
  { label: "collecting-dust", pattern: /\bcollecting dust\b/i },
  { label: "putting-up-posters", pattern: /\bputting up posters\b/i },
  { label: "missing-person", pattern: /\bmissing person\b/i },
  { label: "come-back", pattern: /\bcome back\b/i },

  // ── Streak threats (celebrating a streak is fine; threatening it is not) ──
  { label: "streak-at-risk", pattern: /\bstreak\b.{0,20}\b(at risk|on the line|ending|in danger|slipping)\b/i },
  { label: "streak-protect", pattern: /\b(protect|keep|save|complete|don'?t (break|lose|end))\b.{0,20}\bstreak\b/i },
  { label: "streak-keep-alive", pattern: /\bstreak\b.{0,20}\b(alive|going|don'?t)\b/i },
  { label: "streak-alert", pattern: /\bstreak (alert|risk)\b/i },
  { label: "dont-break-momentum", pattern: /\bdon'?t break (the |your )?(momentum|streak)\b/i },

  // ── Guilt / shame / judgment ──
  { label: "judging-you", pattern: /\bjudg(e|ing)\s*you\b/i },
  { label: "face-the-music", pattern: /\bface the music\b/i },
  { label: "filed-a-complaint", pattern: /\bfiled a complaint\b/i },
  { label: "screaming", pattern: /\bscreaming\b/i },
  { label: "lazy", pattern: /\blazy\b/i },
  { label: "procrastinat", pattern: /\bprocrastinat/i },
  { label: "should-have", pattern: /\byou should('?ve| have)\b/i },
  { label: "why-havent", pattern: /\bwhy (haven'?t|did(n'?t)?)\s*you\b/i },
  { label: "no-excuses", pattern: /\bno excuses?\b/i },
  { label: "passive-aggressive", pattern: /\bno pressure\b.{0,20}\b(but|kinda|though)\b/i },

  // ── Alarm / panic / fake urgency ──
  { label: "sos", pattern: /\bsos\b/i },
  { label: "code-red", pattern: /\bcode red\b/i },
  { label: "red-alert", pattern: /\bred alert\b/i },
  { label: "houston-problem", pattern: /\bhouston,? we have a problem\b/i },
  { label: "alarm-emoji", pattern: /🚨/u },
  { label: "urgent", pattern: /\b(urgent|asap|hurry|last chance|act now)\b/i },
  { label: "screaming-caps-warning", pattern: /\b(WARNING|ALERT|CRITICAL)\b/ },

  // ── FOMO / commercial nag (out of place in a care notification) ──
  { label: "upgrade-nag", pattern: /\b(upgrade|unlock more|go pro|premium)\b/i },
  { label: "dont-miss-out", pattern: /\bdon'?t miss (out|this)\b/i },
];

/** Returns true if the text contains any forbidden pattern. */
export function violatesGuidelines(text: string): boolean {
  return FORBIDDEN.some((rule) => rule.pattern.test(text));
}

/** Returns the labels of every forbidden rule the text matches (for tests / logs). */
export function listViolations(text: string): string[] {
  return FORBIDDEN.filter((rule) => rule.pattern.test(text)).map((r) => r.label);
}

// ── Hardcoded safe fallbacks ───────────────────────────────────────────────────
// IMPORTANT: these are static, guaranteed-clean strings. Never route the
// fallback back through a copy generator — that risks filtering to nothing.
const SAFE_FALLBACKS: { title: string; body: string }[] = [
  { title: "whenever you're ready 🌱", body: "your reminders are here when you want them — no rush." },
  { title: "here when you need it 🤍", body: "nothing urgent. just letting you know we're around." },
  { title: "no pressure 😌", body: "a few things are waiting whenever the moment feels right." },
  { title: "soft check-in 🌿", body: "you're doing fine. open up whenever you like." },
];

function pickFallback(): { title: string; body: string } {
  return SAFE_FALLBACKS[Math.floor(Math.random() * SAFE_FALLBACKS.length)]!;
}

/**
 * Gate a notification's copy. If the combined title+body is clean, returns it
 * unchanged. If it violates the guidelines, returns a safe fallback for
 * whichever fields were provided (preserving which fields exist so callers that
 * only set `body` stay that way).
 */
export function safeNotification(
  title?: string,
  body?: string,
): { title?: string; body?: string } {
  const combined = [title, body].filter(Boolean).join(" ");
  if (!combined || !violatesGuidelines(combined)) return { title, body };
  const fb = pickFallback();
  return {
    title: title !== undefined ? fb.title : undefined,
    body: body !== undefined ? fb.body : undefined,
  };
}
