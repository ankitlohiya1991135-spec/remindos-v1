import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  checkAdminRequest,
  getAdminConvexSecret,
} from "@repo/admin/server";
import type { AdminApiError, OrgCostOverview } from "@repo/admin/types";
import { api } from "@repo/db/convex/api";
import { getConvexClient } from "../../../../lib/server/convex-client";

function jsonError(payload: AdminApiError, status: number) {
  return NextResponse.json(payload, { status });
}

/**
 * GET /api/admin/cost-overview
 *
 * Admin-only. Aggregate token usage + USD cost across the entire
 * org plus a top-10 spenders list. Numbers are estimates (chat-message
 * text only, see `tokens.ts`).
 */
export async function GET() {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    return jsonError(
      { error: guard.reason, code: guard.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" },
      guard.status,
    );
  }

  try {
    // Get all userIds from Clerk (paginated).
    const client = await clerkClient();
    const PAGE = 200;
    const HARD_CAP = 5000;
    const userIds: string[] = [];
    const idToDisplay = new Map<string, string>();
    let offset = 0;
    while (offset < HARD_CAP) {
      const res = await client.users.getUserList({ limit: PAGE, offset });
      for (const u of res.data) {
        userIds.push(u.id);
        idToDisplay.set(
          u.id,
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
            u.username ||
            u.primaryEmailAddress?.emailAddress ||
            u.id,
        );
      }
      if (res.data.length < PAGE) break;
      offset += PAGE;
    }

    if (userIds.length === 0) {
      const empty: OrgCostOverview = {
        totalUsers: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        topSpenders: [],
      };
      return NextResponse.json(empty);
    }

    const convex = getConvexClient();
    const overview = (await convex.query(api.admin.orgCostOverview, {
      adminSecret: getAdminConvexSecret(),
      userIds,
    })) as {
      totalUsers: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
      topSpenders: Array<{
        userId: string;
        totalTokens: number;
        estimatedCostUsd: number;
      }>;
    };

    const enriched: OrgCostOverview = {
      ...overview,
      topSpenders: overview.topSpenders.map((s) => ({
        ...s,
        display: idToDisplay.get(s.userId) ?? s.userId,
      })),
    };

    return NextResponse.json(enriched);
  } catch (err) {
    return jsonError(
      { error: err instanceof Error ? err.message : String(err), code: "INTERNAL" },
      500,
    );
  }
}
