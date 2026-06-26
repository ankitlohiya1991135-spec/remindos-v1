import { ConvexHttpClient } from "convex/browser";
import { auth } from "@clerk/nextjs/server";

function getConvexUrl() {
  return process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL || "";
}

/**
 * Plain (unauthenticated) client — for server-only callers that don't act on
 * behalf of a signed-in user (cron jobs, admin routes gated by their own
 * shared secret). Convex functions called this way see ctx.auth as null.
 */
export function getConvexClient() {
  const convexUrl = getConvexUrl();
  if (!convexUrl) {
    throw new Error("Missing NEXT_PUBLIC_CONVEX_URL (or CONVEX_URL) in web environment.");
  }
  return new ConvexHttpClient(convexUrl);
}

/**
 * Authenticated client — attaches the signed-in user's Clerk "convex" JWT so
 * Convex functions can verify the caller via ctx.auth.getUserIdentity()
 * instead of trusting a client-supplied userId argument. Use this for every
 * route that acts on behalf of the currently signed-in user.
 */
export async function getAuthedConvexClient() {
  const client = getConvexClient();
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (token) client.setAuth(token);
  return client;
}
