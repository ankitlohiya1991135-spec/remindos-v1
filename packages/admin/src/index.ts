/**
 * @repo/admin — environment-agnostic exports.
 *
 * Importing this entry point gives you:
 *   - The global `UserPublicMetadata` augmentation (typed Clerk metadata)
 *   - Pure role helpers (no Clerk SDK required)
 *   - All shared types
 *
 * For server-only Clerk helpers, import from `@repo/admin/server`:
 *   import { checkAdminRequest } from "@repo/admin/server";
 */

export * from "./types";
export * from "./roles";
export * from "./tokens";
export * from "./audit";
