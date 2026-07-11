"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { LoadingState } from "@/components/estimate/loading-state";
import { ResultsView } from "@/components/estimate/results-view";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { runEstimate, runEstimateFromPlan } from "@/app/actions/estimate";
import type { EstimateResult } from "@/lib/ai";

const MIN_LOADING_MS = 2400;

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
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [tick, setTick] = useState(0);

  // Bare /estimate (sidebar "Gutter estimator", old bookmarks): hand
  // off to the start page, which collects an address before anything
  // is spent.
  useEffect(() => {
    if (missingParams) router.replace("/dashboard/proposals/new");
  }, [missingParams, router]);

  useEffect(() => {
    // Nothing to run without a plan or an address — the redirect effect
    // above takes over. Bail before arming the watchdog or calling the
    // (credit-consuming) pipeline.
    if (missingParams) return;

    setPhase("loading");
    setError(null);
    setResult(null);

    let cancelled = false;
    const startedAt = Date.now();

    // Client-side watchdog. Address mode finishes in 25-50s typically
    // — 95s is the bail-out. Plan mode runs Claude vision on a 12 MB
    // PDF which can take 60-120s; bump the watchdog to 240s (just
    // under the 300s maxDuration on the route). Polling re-runs reset
    // the timer because the effect re-mounts on every tick.
    const WATCHDOG_MS = planId ? 240_000 : 95_000;
    const watchdog = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      setError(
        "The estimate is taking longer than usual to come back. An upstream service " +
          "(Solar API, satellite imagery, or AI vision) may be slow right now. Try again.",
      );
      setPhase("error");
    }, WATCHDOG_MS);

    // address is guaranteed non-null when planId is absent — the
    // missingParams guard above already returned otherwise.
    const run = planId
      ? runEstimateFromPlan(planId)
      : runEstimate(address!);

    run
      .then(async (r) => {
        if (cancelled) return;
        clearTimeout(watchdog);
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_LOADING_MS) {
          await new Promise((res) => setTimeout(res, MIN_LOADING_MS - elapsed));
        }
        if (cancelled) return;
        if (r.ok) {
          setResult(r.result);
          setReused(r.reused);
          setPhase("ready");
        } else if ("pending" in r && r.pending) {
          // QUEUED — analysis still running in the after() callback.
          // Stay in loading phase, bump tick after 3s so the effect
          // re-runs and re-polls. Watchdog (95s above) is the upper
          // bound — if it's still pending past that the user sees a
          // real timeout error.
          setTimeout(() => {
            if (!cancelled) setTick((t) => t + 1);
          }, 3000);
        } else {
          setError(r.reason);
          setPhase("error");
        }
      })
      .catch((e) => {
        if (cancelled) return;
        clearTimeout(watchdog);
        // Server action threw rather than returning {ok:false}. Without
        // this catch the rejection bubbles to the route's error.tsx as
        // a generic "Server Components render" 500 with no useful UI.
        console.error("[/estimate] server action threw", e);
        const msg =
          e instanceof Error && e.message
            ? e.message
            : "The estimate service is temporarily unavailable. Try again in a few seconds.";
        setError(msg);
        setPhase("error");
      });

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, [planId, address, missingParams, tick]);

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
      <LoadingState address={headerLabel} mode={planId ? "plan" : "aerial"} />
    );
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
