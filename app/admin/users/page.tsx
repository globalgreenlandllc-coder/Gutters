import { listUsersForAdmin } from "@/app/actions/admin";
import { UsersTable } from "@/components/admin/users-table";

export default async function AdminUsersPage() {
  const rows = await listUsersForAdmin();

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
            Contractors
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every account on the platform. Adjust credits, suspend, or shadow-login.
          </p>
        </div>
        <div className="text-sm text-zinc-500">
          Showing <span className="font-semibold text-zinc-900">{rows.length}</span>{" "}
          {rows.length === 1 ? "user" : "users"}
        </div>
      </header>

      <UsersTable rows={rows} />
    </div>
  );
}
