"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Sparkles } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { ProposalsTable } from "@/components/dashboard/proposals-table";
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
    <DashboardShell
      title="Proposals"
      subtitle="Every estimate and proposal you've drafted, sent, or closed."
      actions={
        <Link
          href="/dashboard/proposals/new"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-accent-700"
        >
          <Plus className="h-4 w-4" />
          New proposal
        </Link>
      }
    >
      {!loading && rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center">
          <div className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-lg bg-accent-50 text-accent-700">
            <Sparkles className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight text-zinc-900">
            No proposals yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
            Run an AI takeoff for any address. Your drafts, sent proposals,
            and accepted jobs will show up here with status filters and
            search.
          </p>
          <Link
            href="/dashboard/proposals/new"
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-accent-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-accent-700"
          >
            <Sparkles className="h-4 w-4" />
            Start your first estimate
          </Link>
        </div>
      ) : (
        <ProposalsTable items={rows} />
      )}
    </DashboardShell>
  );
}
