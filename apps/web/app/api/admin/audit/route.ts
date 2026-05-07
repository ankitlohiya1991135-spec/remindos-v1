import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { checkSuperadminRequest, getAdminConvexSecret } from "@repo/admin/server";
import type {
  AdminApiError,
  AuditLogEntry,
} from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

interface RawAuditRow {
  id: string;
  actorUserId: string;
  actorRole: "admin" | "superadmin";
  action: string;
  targetUserId?: string;
  metadataJson?: string;
  outcome: "ok" | "error";
  errorMessage?: string;
  createdAt: number;
}

/**
 * GET /api/admin/audit?limit=200&targetUserId=user_abc
 *
 * Superadmin-only. Returns the most recent audit events.
 */
export async function GET(request: Request) {
  const guard = await checkSuperadminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 1000)
    : 200;
  const targetUserId = url.searchParams.get("targetUserId") ?? undefined;

  try {
    const convex = getConvexClient();
    const rows = (await convex.query(api.admin.listAuditEvents, {
      adminSecret: getAdminConvexSecret(),
      limit,
      targetUserId,
    })) as RawAuditRow[];

    // Resolve display names for actors + targets in one batch.
    const idsToResolve = new Set<string>();
    for (const r of rows) {
      idsToResolve.add(r.actorUserId);
      if (r.targetUserId) idsToResolve.add(r.targetUserId);
    }
    const displayMap = new Map<string, string>();
    if (idsToResolve.size > 0) {
      const client = await clerkClient();
      // Clerk's getUserList accepts a userId[] filter.
      const res = await client.users.getUserList({
        userId: [...idsToResolve],
        limit: 200,
      });
      for (const u of res.data) {
        const display =
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.primaryEmailAddress?.emailAddress ||
          u.id;
        displayMap.set(u.id, display);
      }
    }

    const enriched: AuditLogEntry[] = rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      actorDisplay: displayMap.get(r.actorUserId) ?? r.actorUserId,
      actorRole: r.actorRole,
      action: r.action as AuditLogEntry["action"],
      targetUserId: r.targetUserId,
      targetDisplay: r.targetUserId
        ? displayMap.get(r.targetUserId) ?? r.targetUserId
        : undefined,
      metadata: r.metadataJson ? safeJsonParse(r.metadataJson) : undefined,
      outcome: r.outcome,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
    }));

    return NextResponse.json({ events: enriched });
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
