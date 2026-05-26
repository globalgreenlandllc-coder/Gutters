"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { LoadingState } from "@/components/estimate/loading-state";
import { ResultsView } from "@/components/estimate/results-view";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { SAMPLE_ADDRESS } from "@/lib/mock-estimate";
import { runEstimate, runEstimateFromPlan } from "@/app/actions/estimate";
import type { EstimateResult } from "@/lib/ai";

const MIN_LOADING_MS = 2400;

function EstimateContent() {
  const params = useSearchParams();
  // Two entry modes:
  //   ?planId=<id>   — read a previously analyzed construction plan
  //   ?address=<str> — run the address pipeline (satellite + Solar + SAM-2)
  // planId wins when both are present.
  const planId = params.get("planId");
  const addressParam = params.get("address");
  const address = addressParam || SAMPLE_ADDRESS;
  // Job-type passed in from the QuickStart card; defaults to replacement
  // (the dominant case). Threaded into ResultsView → proposal so the
  // contractor's saved draft remembers whether this is new vs replacement.
  const jobTypeParam = params.get("jobType");
  const jobType: "new" | "replacement" =
    jobTypeParam === "new" ? "new" : "replacement";
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setPhase("loading");
    setError(null);
    setResult(null);

    let cancelled = false;
    const startedAt = Date.now();

    const run = planId
      ? runEstimateFromPlan(planId)
      : runEstimate(address);

    run.then(async (r) => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_LOADING_MS) {
        await new Promise((res) => setTimeout(res, MIN_LOADING_MS - elapsed));
      }
      if (cancelled) return;
      if (r.ok) {
        setResult(r.result);
        setReused(r.reused);
        setPhase("ready");
      } else {
        setError(r.reason);
        setPhase("error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [planId, address, tick]);

  // In plan mode the "address" label is the filename — surfaced by the
  // server action's geocoded.formatted. Until the result lands we show
  // a generic plan-mode label so the loading screen doesn't read as a
  // real address that doesn't match what the contractor uploaded.
  const headerLabel = planId
    ? "Analyzing construction plans…"
    : address;

  if (phase === "loading") {
    return <LoadingState address={headerLabel} />;
  }
  if (phase === "error") {
    return (
      <ErrorScreen
        address={headerLabel}
        reason={error ?? "Unknown error"}
        onRetry={() => setTick((t) => t + 1)}
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
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-30 [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_70%)]" />
      <div className="relative w-full max-w-lg">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-elevated">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-xl font-semibold tracking-tight text-zinc-900">
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
