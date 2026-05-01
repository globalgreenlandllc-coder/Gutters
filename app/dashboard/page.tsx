"use client";

import { motion } from "framer-motion";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { StatTile } from "@/components/dashboard/stat-tile";
import { ProposalsTable } from "@/components/dashboard/proposals-table";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { QuickStart } from "@/components/dashboard/quick-start";
import { OnboardingStrip } from "@/components/dashboard/onboarding-strip";
import {
  computeKpis,
  mockActivity,
  mockProposals,
} from "@/lib/dashboard-mock";
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
  const kpis = computeKpis(mockProposals);
  const recent = mockProposals.slice(0, 5);

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
            <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
              Welcome back, {session?.user.name.split(" ")[0]}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Here's what's happening across your proposals today.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />
              All systems healthy
            </span>
          </div>
        </motion.header>

        <OnboardingStrip />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            index={0}
            label="Sent this month"
            value={String(kpis.sent)}
            delta="+18%"
            spark={[3, 5, 4, 6, 7, 5, 8]}
          />
          <StatTile
            index={1}
            label="Accepted"
            value={String(kpis.accepted)}
            delta="+12%"
            spark={[1, 2, 1, 3, 2, 4, 3]}
          />
          <StatTile
            index={2}
            label="Revenue MTD"
            value={formatCurrency(kpis.revenueMtd)}
            delta="+24%"
            spark={[2, 4, 3, 6, 7, 9, 11]}
          />
          <StatTile
            index={3}
            label="Pipeline"
            value={formatCurrency(kpis.pipelineValue)}
            delta={`${Math.round(kpis.conversion * 100)}% close rate`}
            positive
            spark={[5, 7, 6, 8, 7, 9, 10]}
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
              <ProposalsTable items={recent} compact showFilters={false} />
            </div>
          </div>

          <div className="space-y-6">
            <ActivityFeed events={mockActivity} />
            <ConversionCard kpis={kpis} />
          </div>
        </section>
      </div>
    </main>
  );
}

function ConversionCard({ kpis }: { kpis: ReturnType<typeof computeKpis> }) {
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
        <div className="pb-1.5 text-xs text-zinc-500">of decided proposals</div>
      </div>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-700"
          style={{ width: `${conv}%` }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span>Avg deal · {formatCurrency(kpis.avgDeal || 0)}</span>
        <span className="text-accent-700">+8% vs Q1</span>
      </div>
    </div>
  );
}
