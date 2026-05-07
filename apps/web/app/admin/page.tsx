import { AdminUserListClient } from "../../components/admin/user-list-client";

/**
 * /admin — admin user-list page.
 *
 * Layout (`./layout.tsx`) already verified admin role server-side.
 * Data fetching is delegated to the client component so the table can be
 * filterable / sortable without a full re-render.
 */
export default function AdminUsersPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          User Management
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Track user activity — prompts sent, daily activity, reminders & tasks.
        </p>
      </header>
      <AdminUserListClient />
    </div>
  );
}
