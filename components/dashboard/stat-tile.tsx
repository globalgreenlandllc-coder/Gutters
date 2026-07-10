"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type IconCmp = React.ComponentType<{ className?: string }>;

/**
 * Hyperline KPI cell. Renders borderless — pages compose 2–4 of these
 * inside a single bordered row (see the Overview page: a grid with
 * `gap-px bg-zinc-100` produces the divide-x hairlines at every breakpoint).
 */
export function StatTile({
  label,
  value,
  delta,
  positive = true,
  spark,
  index = 0,
  Icon,
}: {
  label: string;
  value: string;
  delta?: string;
  positive?: boolean;
  spark?: number[];
  index?: number;
  Icon?: IconCmp;
}) {
  // Uniform, quiet icon chip — a rainbow of per-metric colors read as
  // noise on a summary row.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
      className="bg-white p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-zinc-500">{label}</div>
        {Icon && (
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-50 text-zinc-400">
            <Icon className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="text-[28px] font-semibold tracking-tight tabular-nums text-zinc-900">
          {value}
        </div>
        {spark && <Sparkline data={spark} positive={positive} />}
      </div>
      {delta && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium",
              positive
                ? "bg-emerald-50 text-emerald-600"
                : "bg-rose-50 text-rose-600",
            )}
          >
            {positive ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {delta}
          </span>
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
  const stroke = positive ? "#4353ff" : "#f8717e";
  const fill = positive ? "rgba(67,83,255,0.16)" : "rgba(248,113,126,0.14)";

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
