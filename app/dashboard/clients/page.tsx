"use client";

import { Users } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";

export default function ClientsPage() {
  return (
    <AuthGate>
      <main className="min-h-screen">
        <DashboardNav />
        <div className="mx-auto max-w-[1400px] px-4 py-12 sm:px-6">
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-16 text-center">
            <Users className="mx-auto h-8 w-8 text-zinc-400" />
            <h1 className="font-display mt-4 text-xl font-semibold tracking-tight text-zinc-900">
              Clients directory — coming soon
            </h1>
            <p className="mt-2 text-sm text-zinc-500">
              Search every homeowner you've quoted, see deal history, and trigger
              a follow-up.
            </p>
          </div>
        </div>
      </main>
    </AuthGate>
  );
}
