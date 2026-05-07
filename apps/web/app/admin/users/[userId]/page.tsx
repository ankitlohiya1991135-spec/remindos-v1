import { AdminUserDetailClient } from "../../../../components/admin/user-detail-client";

/**
 * /admin/users/[userId] — per-user activity detail.
 *
 * Layout above already verified admin role. The client component fetches
 * `/api/admin/users/[userId]/activity` which independently re-verifies.
 */
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <AdminUserDetailClient userId={userId} />;
}
