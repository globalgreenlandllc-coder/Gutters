"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { ProposalsTable } from "@/components/dashboard/proposals-table";
import { Button } from "@/components/ui/button";
import {
  listMyProposals,
  type MyProposalRow,
} from "@/app/actions/dashboard";

export default function ProposalsListPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const [rows, setRows] = useState<MyProposalRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listMyProposals()
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

        {!loading && rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700">
              <Sparkles className="h-5 w-5" />
            </div>
            <h2 className="font-display mt-4 text-xl font-semibold tracking-tight text-zinc-900">
              No proposals yet
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
              Run an AI takeoff for any address. Your drafts, sent proposals,
              and accepted jobs will show up here with status filters and
              search.
            </p>
            <Link href="/estimate" className="mt-5 inline-block">
              <Button>
                <Sparkles className="h-4 w-4" />
                Start your first estimate
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        ) : (
          <ProposalsTable items={rows} />
        )}
      </div>
    </main>
  );
}
