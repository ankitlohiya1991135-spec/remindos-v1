import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  countActiveAdmins,
  recordAuditEvent,
} from "@repo/admin/server";
import { getRoleFromPublicMetadata } from "@repo/admin";
import type {
  AdminApiError,
  BulkDeactivateRequest,
  BulkDeactivateResult,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../../lib/server/convex-client";

const MAX_BULK = 100;

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * POST /api/admin/users/bulk-deactivate
 *
 * Admin-only. Bans (or unbans) up to 100 users in a single request.
 * Per-user safety:
 *   - Cannot include the caller's own userId
 *   - Cannot leave zero active admins (counts before any mutation,
 *     so the count is consistent for the whole request)
 *
 * Returns per-user success/failure so the UI can show partial results.
 */
export async function POST(request: Request) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  let body: BulkDeactivateRequest;
  try {
    body = (await request.json()) as BulkDeactivateRequest;
  } catch {
    return jsonError({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }

  if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
    return jsonError(
      { error: "userIds must be a non-empty array", code: "BAD_REQUEST" },
      400,
    );
  }
  if (body.userIds.length > MAX_BULK) {
    return jsonError(
      { error: `Maximum ${MAX_BULK} users per request`, code: "BAD_REQUEST" },
      400,
    );
  }
  if (typeof body.deactivated !== "boolean") {
    return jsonError(
      { error: "deactivated must be a boolean", code: "BAD_REQUEST" },
      400,
    );
  }

  // Drop the caller and any duplicates — don't fail on these; just
  // silently skip and return them as failed entries with a clear reason.
  const seen = new Set<string>();
  const targets: string[] = [];
  const results: BulkDeactivateResult["results"] = [];
  for (const id of body.userIds) {
    if (typeof id !== "string" || !id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === guard.userId) {
      results.push({ userId: id, success: false, error: "Cannot deactivate yourself" });
      continue;
    }
    targets.push(id);
  }

  // Cache admin count once. If we're deactivating, every admin in
  // the batch counts toward the deficit — refuse for ALL admins in the
  // batch when deactivating would leave zero.
  const activeAdmins = body.deactivated ? await countActiveAdmins() : Infinity;

  // Audit a single "request initiated" record so even partial failures
  // have a paper trail.
  const convex = getConvexClient();
  await recordAuditEvent({
    actor: { userId: guard.userId, role: "admin" },
    action: "BULK_DEACTIVATION_REQUESTED",
    metadata: {
      deactivated: body.deactivated,
      requestedCount: targets.length,
    },
    convex,
    mutationRef: api.admin.appendAuditEvent,
  });

  const client = await clerkClient();

  // Count how many admins are in the batch (only relevant when deactivating).
  let adminsInBatch = 0;
  if (body.deactivated) {
    for (const id of targets) {
      try {
        const u = await client.users.getUser(id);
        if (getRoleFromPublicMetadata(u.publicMetadata) === "admin") {
          adminsInBatch++;
        }
      } catch {
        // Ignore — will be reported as a failure below.
      }
    }
  }
  const wouldLeaveZeroAdmins =
    body.deactivated && activeAdmins - adminsInBatch <= 0;

  for (const userId of targets) {
    try {
      const target = await client.users.getUser(userId);
      const role = getRoleFromPublicMetadata(target.publicMetadata);

      if (body.deactivated && role === "admin" && wouldLeaveZeroAdmins) {
        results.push({
          userId,
          success: false,
          error:
            "Cannot deactivate — would leave zero active admins. Promote someone else first.",
        });
        continue;
      }

      if (body.deactivated) {
        await client.users.banUser(userId);
      } else {
        await client.users.unbanUser(userId);
      }

      const existing = target.publicMetadata ?? {};
      const next: Record<string, unknown> = { ...existing };
      if (body.deactivated) next.deactivated = true;
      else delete next.deactivated;
      await client.users.updateUserMetadata(userId, { publicMetadata: next });

      await recordAuditEvent({
        actor: { userId: guard.userId, role: "admin" },
        action: body.deactivated ? "USER_DEACTIVATED" : "USER_REACTIVATED",
        targetUserId: userId,
        metadata: { previousRole: role, viaBulk: true },
        convex,
        mutationRef: api.admin.appendAuditEvent,
      });

      results.push({ userId, success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ userId, success: false, error: msg });
      await recordAuditEvent({
        actor: { userId: guard.userId, role: "admin" },
        action: body.deactivated ? "USER_DEACTIVATED" : "USER_REACTIVATED",
        targetUserId: userId,
        metadata: { viaBulk: true },
        outcome: "error",
        errorMessage: msg,
        convex,
        mutationRef: api.admin.appendAuditEvent,
      });
    }
  }

  const payload: BulkDeactivateResult = {
    ok: true,
    results,
  };
  return NextResponse.json(payload);
}
