"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Check, Loader2, MapPin } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { DUR, EASE } from "@/lib/motion";

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
  const reduce = useReducedMotion();
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

  const onLastStep = stepIndex >= steps.length - 1;

  // Record the wall-clock second the final step began, so the percentage
  // can creep against real elapsed time (not the fake step cascade).
  const [finalStartSec, setFinalStartSec] = useState<number | null>(null);
  useEffect(() => {
    if (onLastStep && finalStartSec === null) setFinalStartSec(elapsedSec);
  }, [onLastStep, elapsedSec, finalStartSec]);

  // ONE monotonic percent that never freezes. The step cascade fills to
  // 88%; the long final step then creeps 88 → ~99 asymptotically (quick
  // at first, always advancing, never quite 100 until the real result
  // swaps this screen out). The old bar hit a full 100% on the final
  // step and sat there — exactly the "is it frozen?" read this removes.
  const CASCADE_CAP = 88;
  const nonFinal = Math.max(1, steps.length - 1);
  const finalElapsed =
    finalStartSec === null ? 0 : Math.max(0, elapsedSec - finalStartSec);
  const tau = mode === "plan" ? 28 : 8;
  const pct = onLastStep
    ? Math.min(99, CASCADE_CAP + (99 - CASCADE_CAP) * (1 - Math.exp(-finalElapsed / tau)))
    : Math.min(CASCADE_CAP, ((stepIndex + 1) / nonFinal) * CASCADE_CAP);
  const pctInt = Math.round(pct);
  const progress = pct / 100;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-paper px-4">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DUR.entrance, ease: EASE }}
        className="relative w-full max-w-xl"
      >
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-2xl border border-zinc-200/70 bg-white p-8 shadow-card">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 h-5 w-5 text-accent-600" />
            <div className="min-w-0 flex-1">
              <div className="microlabel">Running takeoff</div>
              <div className="mt-1 truncate text-[15px] font-semibold tracking-tight text-zinc-900">
                {address}
              </div>
            </div>
          </div>

          {/* Percent + bar. The number ticks every second on the long
              final step (asymptotic creep), so the screen visibly advances
              instead of reading as frozen. */}
          <div className="mt-6 flex items-baseline justify-between">
            <span className="microlabel">
              {onLastStep ? "Finishing up" : "Working"}
            </span>
            <span className="text-sm font-semibold tabular-nums text-accent-700">
              {pctInt}%
            </span>
          </div>
          {/* Track carries the skeleton shimmer (the one permitted infinite
              animation) so the bar still reads "working" while the fill
              creeps on the long final step. Fill animates scaleX — never
              width. */}
          <div className="skeleton mt-2 h-1.5 w-full rounded-full">
            <motion.div
              className="h-full w-full rounded-full bg-accent-600"
              style={{ originX: 0 }}
              initial={reduce ? false : { scaleX: 0 }}
              animate={{ scaleX: progress }}
              transition={{ duration: 0.9, ease: EASE }}
            />
          </div>

          <ul className="mt-6 space-y-2.5">
            {steps.map((s, i) => {
              const state =
                i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
              return (
                <motion.li
                  key={s.id}
                  initial={reduce ? false : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: DUR.slow, ease: EASE, delay: i * 0.05 }}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5"
                >
                  <span className="flex h-6 w-6 items-center justify-center">
                    <AnimatePresence mode="wait">
                      {state === "done" && (
                        <motion.span
                          key="done"
                          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ duration: DUR.fast, ease: EASE }}
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-100 text-accent-700 ring-1 ring-inset ring-accent-200"
                        >
                          <Check className="h-3 w-3" />
                        </motion.span>
                      )}
                      {state === "active" && (
                        <motion.span
                          key="active"
                          initial={reduce ? false : { opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: DUR.fast, ease: EASE }}
                          className="text-accent-600"
                        >
                          <Loader2 className="h-4 w-4 animate-spin" />
                        </motion.span>
                      )}
                      {state === "pending" && (
                        <motion.span
                          key="pending"
                          initial={reduce ? false : { opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: DUR.fast, ease: EASE }}
                          className="h-2 w-2 rounded-full bg-zinc-300"
                        />
                      )}
                    </AnimatePresence>
                  </span>
                  <span
                    className={
                      "transition-smooth " +
                      (state === "done"
                        ? "text-zinc-700"
                        : state === "active"
                        ? "font-medium text-zinc-900"
                        : "text-zinc-400")
                    }
                  >
                    {s.label}
                    {state === "active" && (
                      <span className="ml-1 animate-pulse motion-reduce:animate-none">
                        …
                      </span>
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
            <span className="anim-enter-fade text-zinc-500">
              · Sonnet is tracing — typically 30-60s on the final step
            </span>
          )}
        </div>
      </motion.div>
    </div>
  );
}
