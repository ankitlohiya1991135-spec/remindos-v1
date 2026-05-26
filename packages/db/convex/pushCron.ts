/**
 * pushCron.ts — Convex-native cron trigger for the Vercel push endpoints.
 *
 * Replaces the need for an external cron service (cron-job.org).
 * The Convex scheduler calls `triggerVercelCron` on a fixed interval
 * (see crons.ts), and that action POSTs to the Vercel route which
 * actually does the web-push delivery.
 *
 * Required Convex environment variables (set with `npx convex env set`):
 *   VERCEL_APP_URL   — e.g. https://your-app.vercel.app  (NO trailing slash)
 *   CRON_SECRET      — same value as in Vercel env vars; sent as Bearer token
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const triggerVercelCron = internalAction({
  args: {
    /** Path on the Vercel app, e.g. "/api/push/cron" or "/api/push/smart-cron". */
    path: v.string(),
  },
  handler: async (_ctx, args) => {
    const baseUrl = process.env.VERCEL_APP_URL;
    const secret = process.env.CRON_SECRET;

    if (!baseUrl) {
      console.error(
        "[pushCron] VERCEL_APP_URL not set in Convex env. " +
          "Run: npx convex env set VERCEL_APP_URL https://YOUR-APP.vercel.app",
      );
      return { ok: false, error: "missing_vercel_app_url" as const };
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${args.path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Convex-Cron/1.0",
    };
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const startedAt = Date.now();
    try {
      const res = await fetch(url, { method: "POST", headers });
      const text = await res.text();
      const tookMs = Date.now() - startedAt;
      console.log(
        `[pushCron] POST ${args.path} → ${res.status} (${tookMs}ms) body=${text.slice(0, 200)}`,
      );
      return {
        ok: res.ok,
        status: res.status,
        tookMs,
        bodyPreview: text.slice(0, 500),
      };
    } catch (err) {
      const tookMs = Date.now() - startedAt;
      console.error(`[pushCron] POST ${args.path} threw after ${tookMs}ms:`, err);
      return { ok: false, error: String(err), tookMs };
    }
  },
});
