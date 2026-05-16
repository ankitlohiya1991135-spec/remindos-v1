import { redirect } from "next/navigation";
import Link from "next/link";
import { checkAdminRequest } from "@repo/admin/server";

/**
 * Admin section layout.
 *
 * Server-side guard: any non-admin (including signed-out users) is redirected
 * away. This is a defence-in-depth check on top of the per-API-route guard —
 * the API routes ALSO call `checkAdminRequest()`, so even if a malicious
 * client somehow renders an admin page, the data calls still fail.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const guard = await checkAdminRequest();
  if (!guard.ok) {
    if (guard.status === 401) redirect("/sign-in");
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <nav className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <NavLink href="/admin" label="Users" />
        <NavLink href="/admin/broadcasts" label="Broadcasts" />
        <NavLink href="/admin/audit" label="Audit log" />
        <span className="flex-1" />
        <Link
          href="/dashboard"
          className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
        >
          ← Back to dashboard
        </Link>
      </nav>
      {children}
    </div>
  );
}

function NavLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-violet-300 hover:bg-violet-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-violet-950/40"
    >
      {label}
    </Link>
  );
}
