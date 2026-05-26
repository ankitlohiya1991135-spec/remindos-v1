/**
 * crons.ts — Convex-native scheduled jobs.
 *
 * Convex runs these on its own infrastructure (no Vercel cron, no cron-job.org).
 * Each entry calls an internal action that POSTs to the corresponding
 * Vercel /api/push/* route, which then handles web-push delivery.
 *
 * To change schedules: edit below and run `npx convex deploy`.
 * To pause: comment out the entry and redeploy.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ── Real-time due / pre-due / overdue reminders ────────────────────────────
// Every minute matches the route's 3-minute lookback window so no reminder
// can ever be missed. The route is idempotent (dedup logs in Convex).
crons.interval(
  "trigger push cron every minute",
  { minutes: 1 },
  internal.pushCron.triggerVercelCron,
  { path: "/api/push/cron" },
);

// ── Smart engagement nudges ────────────────────────────────────────────────
// Every 2 hours. The route has a 6-hour dedup window per user, so users
// get at most one nudge per ~6 h regardless of how often this fires.
crons.interval(
  "trigger smart cron every 2 hours",
  { hours: 2 },
  internal.pushCron.triggerVercelCron,
  { path: "/api/push/smart-cron" },
);

export default crons;
