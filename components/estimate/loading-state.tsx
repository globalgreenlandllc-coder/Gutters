"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2, MapPin } from "lucide-react";
import { Logo } from "@/components/ui/logo";

const AERIAL_STEPS = [
  { id: "geocode", label: "Geocoding property" },
  { id: "aerial", label: "Fetching aerial imagery" },
  { id: "segment", label: "Analyzing roof edges" },
  { id: "measure", label: "Calculating linear feet" },
  { id: "downspouts", label: "Placing downspouts" },
  { id: "price", label: "Building takeoff" },
];

// Plan-mode runs a different pipeline: classifier (Haiku) catalogs
// every sheet, picks the roof plan + harvests elevation eave counts,
// then geometry (Sonnet) traces the identified page constrained by
// those counts. Steps mirror that order so the contractor doesn't see
// "Fetching aerial imagery" while staring at their uploaded PDF.
const PLAN_STEPS = [
  { id: "read", label: "Reading plan PDF" },
  { id: "classify", label: "Cataloging sheets" },
  { id: "elevations", label: "Counting eaves on elevations" },
  { id: "roof", label: "Tracing the roof plan" },
  { id: "downspouts", label: "Placing downspouts" },
  { id: "price", label: "Building takeoff" },
];

export function LoadingState({
  address,
  mode = "aerial",
}: {
  address: string;
  mode?: "aerial" | "plan";
}) {
  const steps = mode === "plan" ? PLAN_STEPS : AERIAL_STEPS;
  const [stepIndex, setStepIndex] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Plan-mode work takes 30-90s in practice. Pace the cascade so the
  // first 5 steps finish in ~25s, then the final "Building takeoff"
  // sits with the elapsed counter doing the talking until the
  // Sonnet geometry call returns.
  const dwellMs = mode === "plan" ? 5000 : 420;

  useEffect(() => {
    if (stepIndex >= steps.length - 1) return;
    const t = setTimeout(() => setStepIndex((i) => i + 1), dwellMs);
    return () => clearTimeout(t);
  }, [stepIndex, steps.length, dwellMs]);

  // Wall-clock counter — replaces the user's "is it stuck?" question
  // with a concrete signal. Only ticks while we're loading.
  useEffect(() => {
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const progress = Math.min((stepIndex + 1) / steps.length, 1);
  const onLastStep = stepIndex >= steps.length - 1;

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_70%)]" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[400px] w-[600px] -translate-x-1/2 rounded-full bg-accent-200/40 blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative w-full max-w-xl"
      >
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-elevated">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 h-5 w-5 text-accent-600" />
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Analyzing
              </div>
              <div className="mt-1 truncate font-medium text-zinc-900">
                {address}
              </div>
            </div>
          </div>

          <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-zinc-100">
            <motion.div
              className="h-full bg-gradient-to-r from-accent-500 via-accent-600 to-cyan-500"
              initial={{ width: 0 }}
              animate={{ width: `${progress * 100}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          </div>

          <ul className="mt-6 space-y-2.5">
            {steps.map((s, i) => {
              const state =
                i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
              return (
                <motion.li
                  key={s.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5"
                >
                  <span className="flex h-6 w-6 items-center justify-center">
                    <AnimatePresence mode="wait">
                      {state === "done" && (
                        <motion.span
                          key="done"
                          initial={{ scale: 0.6, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-100 text-accent-700 ring-1 ring-inset ring-accent-200"
                        >
                          <Check className="h-3 w-3" />
                        </motion.span>
                      )}
                      {state === "active" && (
                        <motion.span
                          key="active"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="text-accent-600"
                        >
                          <Loader2 className="h-4 w-4 animate-spin" />
                        </motion.span>
                      )}
                      {state === "pending" && (
                        <motion.span
                          key="pending"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="h-2 w-2 rounded-full bg-zinc-300"
                        />
                      )}
                    </AnimatePresence>
                  </span>
                  <span
                    className={
                      state === "done"
                        ? "text-zinc-700"
                        : state === "active"
                        ? "font-medium text-zinc-900"
                        : "text-zinc-400"
                    }
                  >
                    {s.label}
                    {state === "active" && (
                      <span className="ml-1 animate-pulse">…</span>
                    )}
                  </span>
                </motion.li>
              );
            })}
          </ul>
        </div>

        <p className="mt-4 text-center text-xs text-zinc-500">
          {mode === "plan"
            ? "Two-stage AI: Haiku sheet inventory · Sonnet roof-plan geometry"
            : "Running in parallel: Solar API · Vision segmentation · Turf.js geometry"}
        </p>

        {/* Wall-clock elapsed + reassurance copy on plan mode where
            the final Sonnet call can sit for 30-60s after the cascade
            finishes. Without this the contractor sees "Building
            takeoff…" with no feedback and assumes the app is stuck. */}
        <div className="mt-3 flex items-center justify-center gap-2 text-center text-[11px] text-zinc-400">
          <span className="tabular-nums">{elapsedSec}s elapsed</span>
          {mode === "plan" && onLastStep && (
            <span className="text-zinc-500">
              · Sonnet is tracing — typically 30-60s on the final step
            </span>
          )}
        </div>
      </motion.div>
    </div>
  );
}
