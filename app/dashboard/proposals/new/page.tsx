"use client";

import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { StartOptions } from "@/components/dashboard/start-options";

export default function NewProposalPage() {
  return (
    <AuthGate>
      <DashboardShell fullBleed={false}>
        {/* This page draws its own header (no shell title). */}
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
          New proposal
        </div>
        <h1 className="mt-2 max-w-md text-[34px] font-semibold leading-[1.05] tracking-tight text-zinc-900 sm:text-[40px]">
          How do you want to start?
        </h1>
        <div className="mt-6 border-b border-zinc-200" />

        <StartOptions />
      </DashboardShell>
    </AuthGate>
  );
}
