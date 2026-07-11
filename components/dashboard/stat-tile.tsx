"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * KPI tile — each tile is its own white card. Pages compose them in a
 * `grid gap-4 sm:grid-cols-2 xl:grid-cols-4` row (see the Overview page).
 */
export function StatTile({
  label,
  value,
  footnote,
  delta,
  index = 0,
  loading = false,
}: {
  label: string;
  value: string;
  footnote?: string;
  delta?: { text: string; positive: boolean };
  index?: number;
  /** Pulse-skeleton state while the overview data is in flight. */
  loading?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  if (loading) {
    return (
      <div className="rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-card">
        <div className="animate-pulse">
          <div className="h-3 w-20 rounded bg-zinc-100" />
          <div className="mt-2 h-8 w-28 rounded-lg bg-zinc-100" />
        </div>
      </div>
    );
  }
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      className="rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400">
          {label}
        </div>
        {delta && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px] font-semibold",
              delta.positive ? "text-emerald-700" : "text-rose-600",
            )}
          >
            {delta.positive ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {delta.text}
          </span>
        )}
      </div>
      <div className="mt-2 text-[30px] font-semibold tracking-tight text-zinc-900">
        {value}
      </div>
      {footnote && <div className="mt-1 text-xs text-zinc-400">{footnote}</div>}
    </motion.div>
  );
}
