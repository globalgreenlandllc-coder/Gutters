"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  DollarSign,
  HandCoins,
  Hammer,
  Send,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { StatTile } from "@/components/dashboard/stat-tile";
import { ProposalsTable } from "@/components/dashboard/proposals-table";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { QuickStart } from "@/components/dashboard/quick-start";
import { OnboardingStrip } from "@/components/dashboard/onboarding-strip";
import { NeedsAttention } from "@/components/dashboard/needs-attention";
import { Button } from "@/components/ui/button";
import {
  listMyActivity,
  listMyProposals,
  getMyKpis,
  type MyActivityEvent,
  type MyKpis,
  type MyProposalRow,
} from "@/app/actions/dashboard";
import {
  getNeedsAttention,
  getPaymentStats,
  type AttentionItem,
  type PaymentStats,
} from "@/app/actions/payments";
import { formatCurrency } from "@/lib/utils";
import { useSession } from "@/lib/auth-mock";

export default function DashboardPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const { session } = useSession();
  const [proposals, setProposals] = useState<MyProposalRow[]>([]);
  const [kpis, setKpis] = useState<MyKpis | null>(null);
  const [activity, setActivity] = useState<MyActivityEvent[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [money, setMoney] = useState<PaymentStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listMyProposals(),
      getMyKpis(),
      listMyActivity(),
      getNeedsAttention(),
      getPaymentStats(),
    ])
      .then(([p, k, a, att, m]) => {
        if (cancelled) return;
        setProposals(p);
        setKpis(k);
        setActivity(a);
        setAttention(att);
        setMoney(m);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const k = kpis ?? {
    sent: 0,
    accepted: 0,
    revenueMtd: 0,
    conversion: 0,
    pipelineValue: 0,
    avgDeal: 0,
  };
  const recent = proposals.slice(0, 5);
  const isEmpty = !loading && proposals.length === 0;

  return (
    <DashboardShell title="Overview">
      <div className="space-y-8">
        <p className="text-sm text-zinc-500">
          {greetingTime()}, {session?.user.name.split(" ")[0]} —{" "}
          {isEmpty
            ? "your dashboard is ready. Run your first estimate to start filling it in."
            : "here's what's happening across your proposals today."}
        </p>

        <OnboardingStrip />

        <section className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-card sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            index={0}
            label="Sent this month"
            value={String(k.sent)}
            Icon={Send}
            tone="accent"
          />
          <StatTile
            index={1}
            label="Accepted"
            value={String(k.accepted)}
            Icon={CheckCircle2}
            tone="emerald"
          />
          <StatTile
            index={2}
            label="Revenue MTD"
            value={formatCurrency(k.revenueMtd)}
            Icon={DollarSign}
            tone="violet"
          />
          <StatTile
            index={3}
            label="Pipeline"
            value={formatCurrency(k.pipelineValue)}
            Icon={TrendingUp}
            tone="coral"
            delta={
              k.pipelineValue > 0
                ? `${Math.round(k.conversion * 100)}% close rate`
                : undefined
            }
          />
        </section>

        {/* Money row — collections across accepted jobs */}
        {money &&
          (money.jobsInProgress > 0 ||
            money.jobsDone > 0 ||
            money.collectedMtdCents > 0) && (
            <section className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-card sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                index={0}
                label="Collected this month"
                value={formatCurrency(money.collectedMtdCents / 100)}
                Icon={HandCoins}
                tone="emerald"
              />
              <StatTile
                index={1}
                label="Outstanding"
                value={formatCurrency(money.outstandingCents / 100)}
                Icon={Wallet}
                tone="accent"
                delta={
                  money.jobsInProgress > 0
                    ? `${money.jobsInProgress} job${money.jobsInProgress === 1 ? "" : "s"} in progress`
                    : undefined
                }
              />
              <StatTile
                index={2}
                label="Overdue"
                value={formatCurrency(money.overdueCents / 100)}
                Icon={AlertTriangle}
                tone={money.overdueCount > 0 ? "rose" : "amber"}
                positive={money.overdueCount === 0}
                delta={
                  money.overdueCount > 0
                    ? `${money.overdueCount} payment${money.overdueCount === 1 ? "" : "s"} late`
                    : "nothing late"
                }
              />
              <StatTile
                index={3}
                label="Done jobs"
                value={String(money.jobsDone)}
                Icon={Hammer}
                tone="violet"
                delta={
                  money.pendingChangeOrders > 0
                    ? `${money.pendingChangeOrders} change order${money.pendingChangeOrders === 1 ? "" : "s"} pending`
                    : undefined
                }
              />
            </section>
          )}

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <QuickStart />
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-zinc-900">
                  <span className="h-4 w-1 rounded-full bg-cta-gradient" aria-hidden />
                  Recent proposals
                </h2>
              </div>
              {isEmpty ? (
                <EmptyProposals />
              ) : (
                <ProposalsTable
                  items={recent}
                  compact={proposals.length > 5}
                  showFilters={false}
                />
              )}
            </div>
          </div>

          <div className="space-y-6">
            <NeedsAttention items={attention} loading={loading} />
            <ActivityFeed events={activity} />
            {k.sent > 0 && <ConversionCard kpis={k} />}
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}

function EmptyProposals() {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center">
      <div className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-lg bg-cta-gradient text-white shadow-glow">
        <Sparkles className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-lg font-semibold tracking-tight text-zinc-900">
        No proposals yet
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
        Run an AI takeoff for any address — your draft, the proposal you send,
        and the homeowner's response will all land here.
      </p>
      <Link href="/estimate" className="mt-5 inline-block">
        <Button>
          <Sparkles className="h-4 w-4" />
          Start your first estimate
          <ArrowRight className="h-4 w-4" />
        </Button>
      </Link>
    </div>
  );
}

function ConversionCard({ kpis }: { kpis: MyKpis }) {
  const conv = Math.round(kpis.conversion * 100);
  return (
    <div className="surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight text-zinc-900">
          Win rate
        </h3>
        <span className="text-xs text-zinc-400">All time</span>
      </div>
      <div className="mt-4 flex items-end gap-4">
        <div className="text-[26px] font-semibold tracking-tight tabular-nums text-zinc-900">
          {conv}%
        </div>
        <div className="pb-1.5 text-xs text-zinc-500">
          {kpis.accepted + (kpis.sent - kpis.accepted) > 0
            ? "of decided proposals"
            : "no decided proposals yet"}
        </div>
      </div>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
        <div
          className="h-full rounded-full bg-cta-gradient"
          style={{ width: `${conv}%` }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span>Avg deal · {formatCurrency(kpis.avgDeal || 0)}</span>
      </div>
    </div>
  );
}

function greetingTime(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}
