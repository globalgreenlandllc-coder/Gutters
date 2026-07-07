"use client";

import { useEffect, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { NewEstimateDialog } from "@/components/dashboard/new-estimate-dialog";
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
  const [dialogOpen, setDialogOpen] = useState(false);

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
      actions={
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New estimate
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-500">
          Every estimate and proposal you've drafted, sent, or closed.
        </p>

        {!loading && rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center">
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
            <Button
              onClick={() => setDialogOpen(true)}
              className="mt-5"
            >
              <Sparkles className="h-4 w-4" />
              Start your first estimate
            </Button>
          </div>
        ) : (
          <ProposalsTable items={rows} />
        )}
      </div>

      <NewEstimateDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </DashboardShell>
  );
}
