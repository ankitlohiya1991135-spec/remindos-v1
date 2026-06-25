import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Verifies the caller is actually who they claim to be in the `userId`
 * argument, instead of trusting it as a plain string. Requires the client to
 * have attached a Clerk "convex" JWT (see apps/web/lib/server/convex-client.ts
 * getAuthedConvexClient). Throws if there's no verified identity, or if the
 * verified identity doesn't match the claimed userId.
 */
export async function requireUser(ctx: QueryCtx | MutationCtx, userId: string) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.subject !== userId) {
    throw new Error("Unauthorized");
  }
}
