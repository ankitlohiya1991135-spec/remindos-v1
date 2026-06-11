/**
 * Win Celebration copy (in-app moment).
 *
 * Fires when the user completes a reminder. ADHD principle: a dopamine reward
 * that counters the "i'm lazy" shame spiral. Tone: warm, lowercase, genuinely
 * proud — never corporate ("Task completed ✓"). Long-pending wins (a reminder
 * that sat for >3 days) get extra acknowledgement, because for an ADHD brain
 * those are the hardest and most shame-laden to clear.
 *
 * All lines are hand-verified clean against the anti-surveillance filter
 * (no guilt, no "finally", no "about time").
 */

export interface WinCopy {
  /** Big celebratory line. */
  line: string;
  /** Optional warmer sub-line. */
  sub?: string;
}

const REGULAR: WinCopy[] = [
  { line: "done! that's one off the list 🔥" },
  { line: "nice — that's done ✅", sub: "small wins count too." },
  { line: "one down 🌱", sub: "that's a real one." },
  { line: "look at you, doing the thing ✅" },
  { line: "boom, done 🔥", sub: "let that feel good." },
];

const LONG_PENDING: WinCopy[] = [
  { line: "you did it 🔥", sub: "that one had been waiting a while — that's a real win. let yourself feel it." },
  { line: "the old one's done ✅", sub: "for an adhd brain, that's not small. proud of you." },
  { line: "cleared it 🌱", sub: "that'd been sitting there a few days. genuinely big." },
];

const PENDING_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

/** True when a reminder has been on the list (created) for more than ~3 days. */
export function isLongPending(createdAtIso?: string, now = Date.now()): boolean {
  if (!createdAtIso) return false;
  const created = new Date(createdAtIso).getTime();
  if (!Number.isFinite(created)) return false;
  return now - created > PENDING_THRESHOLD_MS;
}

/** Pick a fresh, warm win line — extra acknowledgement for long-pending clears. */
export function pickWinCopy(opts: { longPending: boolean }): WinCopy {
  const pool = opts.longPending ? LONG_PENDING : REGULAR;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
