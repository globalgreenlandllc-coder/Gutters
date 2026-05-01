"use client";

import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { ProposalsTable } from "@/components/dashboard/proposals-table";
import { Button } from "@/components/ui/button";
import { mockProposals } from "@/lib/dashboard-mock";

export default function ProposalsListPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  return (
    <main className="min-h-screen">
      <DashboardNav />

      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
              Proposals
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Every estimate and proposal you've drafted, sent, or closed.
            </p>
          </div>
          <Link href="/estimate">
            <Button>
              <Sparkles className="h-4 w-4" />
              New estimate
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </header>

        <ProposalsTable items={mockProposals} />
      </div>
    </main>
  );
}
