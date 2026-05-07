import { redirect } from "next/navigation";
import { checkSuperadminRequest } from "@repo/admin/server";
import { AuditLogClient } from "../../../components/admin/audit-log-client";

export default async function AdminAuditPage() {
  const guard = await checkSuperadminRequest();
  if (!guard.ok) {
    if (guard.status === 401) redirect("/sign-in");
    redirect("/admin");
  }

  return (
    <div>
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            Audit log
          </h1>
          <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
            Superadmin
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Append-only record of every admin and superadmin action. Cannot be
          edited or deleted by anyone.
        </p>
      </header>
      <AuditLogClient />
    </div>
  );
}
