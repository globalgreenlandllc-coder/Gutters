"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  DollarSign,
  Send,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { StatTile } from "@/components/dashboard/stat-tile";
import { ProposalsTable } from "@/components/dashboard/proposals-table";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { QuickStart } from "@/components/dashboard/quick-start";
import { OnboardingStrip } from "@/components/dashboard/onboarding-strip";
import { Button } from "@/components/ui/button";
import {
  listMyActivity,
  listMyProposals,
  getMyKpis,
  type MyActivityEvent,
  type MyKpis,
  type MyProposalRow,
} from "@/app/actions/dashboard";
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listMyProposals(), getMyKpis(), listMyActivity()])
      .then(([p, k, a]) => {
        if (cancelled) return;
        setProposals(p);
        setKpis(k);
        setActivity(a);
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
    <main className="min-h-screen">
      <DashboardNav />

      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <motion.header
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-end justify-between gap-3"
        >
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              {greetingTime()}
            </div>
            <h1 className="font-display mt-0.5 text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
              Welcome back,{" "}
              <span className="bg-gradient-to-r from-accent-600 to-emerald-500 bg-clip-text text-transparent">
                {session?.user.name.split(" ")[0]}
              </span>
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {isEmpty
                ? "Your dashboard is ready. Run your first estimate to start filling it in."
                : "Here's what's happening across your proposals today."}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50/60 px-2.5 py-1 text-emerald-700">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              All systems healthy
            </span>
          </div>
        </motion.header>

        <OnboardingStrip />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            index={0}
            label="Sent this month"
            value={String(k.sent)}
            Icon={Send}
            tone="sky"
            delta={k.sent > 0 ? undefined : "Send your first proposal"}
          />
          <StatTile
            index={1}
            label="Accepted"
            value={String(k.accepted)}
            Icon={CheckCircle2}
            tone="emerald"
            delta={k.accepted > 0 ? undefined : "—"}
          />
          <StatTile
            index={2}
            label="Revenue MTD"
            value={formatCurrency(k.revenueMtd)}
            Icon={DollarSign}
            tone="emerald"
            delta={k.revenueMtd > 0 ? undefined : "—"}
          />
          <StatTile
            index={3}
            label="Pipeline"
            value={formatCurrency(k.pipelineValue)}
            Icon={TrendingUp}
            tone="violet"
            delta={
              k.pipelineValue > 0
                ? `${Math.round(k.conversion * 100)}% close rate`
                : "—"
            }
          />
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <QuickStart />
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
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
            <ActivityFeed events={activity} />
            <ConversionCard kpis={k} />
          </div>
        </section>
      </div>
    </main>
  );
}

function EmptyProposals() {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-10 text-center shadow-sm">
      <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700">
        <Sparkles className="h-5 w-5" />
      </div>
      <h3 className="font-display mt-4 text-lg font-semibold tracking-tight text-zinc-900">
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
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-semibold tracking-tight text-zinc-900">
          Win rate
        </h3>
        <span className="text-xs text-zinc-500">All time</span>
      </div>
      <div className="mt-4 flex items-end gap-4">
        <div className="font-display text-4xl font-semibold tracking-tight tabular-nums text-zinc-900">
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
          className="h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-700"
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
