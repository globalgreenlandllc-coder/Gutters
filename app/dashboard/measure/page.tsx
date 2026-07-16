"use client";

import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { ManualMeasureForm } from "@/components/dashboard/manual-measure-form";

/**
 * Manual proposal — a self-contained flow, separate from the AI-takeoff
 * /proposal builder. For jobs with no blueprints and an address the
 * satellite scan can't resolve: the contractor measured the house on
 * site, types the numbers in, reviews the packages, and sends the
 * proposal right here.
 */
export default function ManualMeasurePage() {
  return (
    <AuthGate>
      <DashboardShell fullBleed={false}>
        <div className="anim-enter font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
          Manual proposal
        </div>
        <h1 className="anim-enter stagger-1 mt-2 max-w-xl text-[34px] font-semibold leading-[1.05] tracking-tight text-zinc-900 sm:text-[40px]">
          Type in what you measured on site
        </h1>
        <p className="anim-enter stagger-2 mt-3 max-w-xl text-sm leading-relaxed text-zinc-500">
          No blueprints? Address won&apos;t scan? Enter the gutter runs off
          your tape measure — downspouts and end caps suggest themselves,
          every package prices live, and you send the finished proposal
          right from this page.
        </p>
        <div className="mt-6 border-b border-zinc-200" />

        <ManualMeasureForm />
      </DashboardShell>
    </AuthGate>
  );
}
