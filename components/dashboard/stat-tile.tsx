"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type IconCmp = React.ComponentType<{ className?: string }>;

export function StatTile({
  label,
  value,
  delta,
  positive = true,
  spark,
  index = 0,
  Icon,
  tone = "emerald",
}: {
  label: string;
  value: string;
  delta?: string;
  positive?: boolean;
  spark?: number[];
  index?: number;
  Icon?: IconCmp;
  /** Visual tone of the icon chip + accent line. */
  tone?: "emerald" | "violet" | "sky" | "amber";
}) {
  const toneClasses = {
    emerald: {
      chipBg: "bg-emerald-50 text-emerald-700 ring-emerald-200",
      accent: "from-emerald-400 to-emerald-600",
    },
    violet: {
      chipBg: "bg-violet-50 text-violet-700 ring-violet-200",
      accent: "from-violet-400 to-violet-600",
    },
    sky: {
      chipBg: "bg-sky-50 text-sky-700 ring-sky-200",
      accent: "from-sky-400 to-sky-600",
    },
    amber: {
      chipBg: "bg-amber-50 text-amber-700 ring-amber-200",
      accent: "from-amber-400 to-amber-600",
    },
  }[tone];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      whileHover={{ y: -2 }}
      className="group relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5 shadow-card transition hover:border-zinc-300 hover:shadow-elevated"
    >
      {/* Top-edge accent line, brighter on hover. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r opacity-60 transition group-hover:opacity-100",
          toneClasses.accent,
        )}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </div>
        {Icon && (
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset",
              toneClasses.chipBg,
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="font-display text-3xl font-semibold tracking-tight text-zinc-900 tabular-nums">
          {value}
        </div>
        {spark && <Sparkline data={spark} positive={positive} />}
      </div>
      {delta && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium",
              positive
                ? "bg-accent-50 text-accent-700"
                : "bg-rose-50 text-rose-700",
            )}
          >
            {positive ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {delta}
          </span>
          <span className="text-zinc-400">vs. last month</span>
        </div>
      )}
    </motion.div>
  );
}

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const w = 90;
  const h = 32;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = positive ? "#059669" : "#e11d48";
  const fill = positive ? "rgba(5,150,105,0.10)" : "rgba(225,29,72,0.10)";

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <defs>
        <linearGradient id={`sg-${positive ? "p" : "n"}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} />
          <stop offset="100%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
      <polygon
        fill={`url(#sg-${positive ? "p" : "n"})`}
        points={`0,${h} ${pts} ${w},${h}`}
      />
    </svg>
  );
}
