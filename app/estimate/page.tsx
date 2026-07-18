"use client";

import Link from "next/link";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, RotateCw, Ruler } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { LoadingState } from "@/components/estimate/loading-state";
import { ResultsView } from "@/components/estimate/results-view";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { takeoffJobKey, useEstimateJob } from "@/components/estimate/estimate-job";

function EstimateContent() {
  const router = useRouter();
  const params = useSearchParams();
  // Two entry modes:
  //   ?planId=<id>   — read a previously analyzed construction plan
  //   ?address=<str> — run the address pipeline (satellite + Solar + SAM-2)
  // planId wins when both are present. With NEITHER present there is
  // nothing to run — a takeoff costs a credit and real API spend, so we
  // never fall back to a sample address; we redirect to the start page
  // (which collects address + job type) instead.
  const planId = params.get("planId");
  const addressParam = params.get("address");
  const address = addressParam;
  const missingParams = !planId && !address;
  // Job-type passed in from the new-proposal start page; defaults to replacement
  // (the dominant case). Threaded into ResultsView → proposal so the
  // contractor's saved draft remembers whether this is new vs replacement.
  const jobTypeParam = params.get("jobType");
  const jobType: "new" | "replacement" =
    jobTypeParam === "new" ? "new" : "replacement";

  // The run/poll/watchdog machinery lives in EstimateJobProvider (root
  // layout) so the analysis survives navigation — the contractor can
  // minimize this screen and keep working while the floating
  // mini-window tracks progress, then gets bounced back here on ready.
  const { job, startJob } = useEstimateJob();

  // Bare /estimate (sidebar "Gutter estimator", old bookmarks): hand
  // off to the start page, which collects an address before anything
  // is spent.
  useEffect(() => {
    if (missingParams) router.replace("/dashboard/proposals/new");
  }, [missingParams, router]);

  useEffect(() => {
    // Nothing to run without a plan or an address — the redirect effect
    // above takes over. startJob is idempotent, so returning to a page
    // whose job is already running (or done) just re-attaches.
    if (missingParams) return;
    startJob({ planId, address, jobType });
  }, [planId, address, jobType, missingParams, startJob]);

  // Only trust the provider's job if it's OURS — a stale job for a
  // different plan/address (e.g. mid-swap render) must not leak its
  // result into this page.
  const key = takeoffJobKey({ planId, address, jobType });
  const active = job && key && job.key === key ? job : null;
  const phase: "loading" | "ready" | "error" =
    active?.phase === "ready"
      ? "ready"
      : active?.phase === "error"
        ? "error"
        : "loading";
  const result = active?.result ?? null;
  const error = active?.error ?? null;
  const reused = active?.reused ?? false;

  // In plan mode the "address" label is the filename — surfaced by the
  // server action's geocoded.formatted. Until the result lands we show
  // a generic plan-mode label so the loading screen doesn't read as a
  // real address that doesn't match what the contractor uploaded.
  const headerLabel = planId
    ? "Analyzing construction plans…"
    : (address ?? "");

  if (missingParams) {
    // Redirecting (effect above) — a quiet placeholder instead of a
    // loading screen that would imply a takeoff is running.
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="anim-enter-fade text-sm text-zinc-500">
          Taking you to the start page…
        </p>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <LoadingState
        address={headerLabel}
        mode={planId ? "plan" : "aerial"}
        startedAt={active?.startedAt}
        onMinimize={() => router.push("/dashboard")}
      />
    );
  }
  if (phase === "error") {
    return (
      <ErrorScreen
        address={headerLabel}
        reason={error ?? "Unknown error"}
        onRetry={() => startJob({ planId, address, jobType }, { force: true })}
      />
    );
  }
  if (result) {
    return (
      <ResultsView
        address={result.geocoded.formatted}
        initial={result}
        reused={reused}
        jobType={jobType}
        planId={planId ?? undefined}
      />
    );
  }
  return null;
}

function ErrorScreen({
  address,
  reason,
  onRetry,
}: {
  address: string;
  reason: string;
  onRetry: () => void;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="pointer-events-none absolute inset-0 hl-grid" />
      {/* Entrance mirrors LoadingState's card rise so the loading→error
          hand-off (often after a 95s watchdog) doesn't pop. */}
      <div className="anim-enter relative w-full max-w-lg">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-8 shadow-card">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
                We couldn't run that estimate
              </h1>
              <p className="mt-1 truncate text-sm text-zinc-500">{address}</p>
            </div>
          </div>
          <p className="mt-5 text-sm leading-relaxed text-zinc-600">{reason}</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <Button onClick={onRetry} className="flex-1">
              <RotateCw className="h-4 w-4" />
              Try again
            </Button>
            <Link href="/dashboard" className="flex-1">
              <Button variant="secondary" className="w-full">
                <ArrowLeft className="h-4 w-4" />
                Back to dashboard
              </Button>
            </Link>
          </div>

          {/* Escape hatch: the scan won't ever work for some addresses
              (bad imagery, rural lots, new builds). Route the contractor
              to the tape-measure flow instead of a retry dead-end. */}
          <div className="mt-4 rounded-lg bg-accent-50 p-4 ring-1 ring-inset ring-accent-200">
            <div className="flex items-start gap-2.5">
              <Ruler className="mt-0.5 h-4 w-4 shrink-0 text-accent-700" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-accent-900">
                  Address won&apos;t scan? Build it manually.
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-accent-800/80">
                  Type in the gutter runs you measured on site — packages
                  price live and you can send the proposal from one page.
                </p>
                <Link
                  href="/dashboard/measure"
                  className="transition-smooth ring-focus group mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent-700 hover:text-accent-900"
                >
                  Start a manual proposal
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function EstimatePage() {
  return (
    <AuthGate>
      <Suspense fallback={<LoadingState address="…" />}>
        <EstimateContent />
      </Suspense>
    </AuthGate>
  );
}
