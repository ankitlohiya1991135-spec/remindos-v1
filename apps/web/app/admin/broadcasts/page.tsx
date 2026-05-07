import { checkAdminRequest } from "@repo/admin/server";
import { redirect } from "next/navigation";
import { BroadcastsClient } from "../../../components/admin/broadcasts-client";

export default async function AdminBroadcastsPage() {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    if (guard.status === 401) redirect("/sign-in");
    redirect("/dashboard");
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          Broadcasts
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Send a notification to a user segment. You can recall any broadcast
          you sent. Superadmins can recall anyone&apos;s broadcast.
        </p>
      </header>
      <BroadcastsClient
        viewerUserId={guard.userId}
        viewerRole={guard.role}
      />
    </div>
  );
}
