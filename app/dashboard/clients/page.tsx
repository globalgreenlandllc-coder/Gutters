"use client";

import { Users } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";

export default function ClientsPage() {
  return (
    <AuthGate>
      <DashboardShell title="Clients">
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-16 text-center">
          <div className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
            <Users className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight text-zinc-900">
            Clients directory — coming soon
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            Search every homeowner you've quoted, see deal history, and trigger
            a follow-up.
          </p>
        </div>
      </DashboardShell>
    </AuthGate>
  );
}
