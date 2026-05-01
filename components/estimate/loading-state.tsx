"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2, MapPin } from "lucide-react";
import { Logo } from "@/components/ui/logo";

const STEPS = [
  { id: "geocode", label: "Geocoding property" },
  { id: "aerial", label: "Fetching aerial imagery" },
  { id: "segment", label: "Analyzing roof edges" },
  { id: "measure", label: "Calculating linear feet" },
  { id: "downspouts", label: "Placing downspouts" },
  { id: "price", label: "Building takeoff" },
];

export function LoadingState({
  address,
  onComplete,
}: {
  address: string;
  onComplete: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (stepIndex >= STEPS.length) {
      const t = setTimeout(onComplete, 320);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStepIndex((i) => i + 1), 620);
    return () => clearTimeout(t);
  }, [stepIndex, onComplete]);

  const progress = Math.min(stepIndex / STEPS.length, 1);

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
            {STEPS.map((s, i) => {
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
          Running in parallel: Solar API · Vision segmentation · Turf.js geometry
        </p>
      </motion.div>
    </div>
  );
}
