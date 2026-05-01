"use client";

import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function Preview() {
  return (
    <section className="relative mx-auto max-w-7xl px-4 pb-24">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.7 }}
      >
        <Card className="overflow-hidden p-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
            <AerialMock />
            <SummaryMock />
          </div>
        </Card>
      </motion.div>
    </section>
  );
}

function AerialMock() {
  const eaves = [
    "M180 240 H520",
    "M180 360 H520",
    "M520 270 H660",
    "M520 350 H660",
    "M260 200 H420",
  ];

  return (
    <div className="relative aspect-[16/10] overflow-hidden rounded-xl bg-[#13261b]">
      <svg
        viewBox="0 0 800 500"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <defs>
          <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1d3a26" />
            <stop offset="100%" stopColor="#0d1f15" />
          </linearGradient>
          <linearGradient id="roof" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3a3530" />
            <stop offset="100%" stopColor="#2a2520" />
          </linearGradient>
          <pattern id="shingle" width="14" height="6" patternUnits="userSpaceOnUse">
            <path d="M0 6 L14 6" stroke="rgba(0,0,0,0.25)" />
          </pattern>
        </defs>

        <rect width="800" height="500" fill="url(#grass)" />
        <rect x="0" y="0" width="800" height="500" fill="url(#shingle)" opacity="0.05" />

        <g opacity="0.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <circle
              key={`tree-${i}`}
              cx={40 + i * 65}
              cy={i % 2 === 0 ? 60 : 460}
              r={14 + (i % 3) * 4}
              fill="#1f3a25"
              stroke="#0d1f15"
              strokeWidth="2"
            />
          ))}
        </g>

        <rect x="60" y="430" width="120" height="50" rx="4" fill="#2c3038" opacity="0.6" />
        <rect x="600" y="100" width="160" height="40" rx="4" fill="#2c3038" opacity="0.5" />

        <rect x="180" y="200" width="340" height="180" fill="url(#roof)" stroke="#1a1612" />
        <rect x="180" y="200" width="340" height="180" fill="url(#shingle)" />
        <rect x="520" y="270" width="140" height="80" fill="url(#roof)" stroke="#1a1612" />
        <rect x="520" y="270" width="140" height="80" fill="url(#shingle)" />
        <rect x="260" y="170" width="160" height="35" fill="url(#roof)" stroke="#1a1612" />

        <line x1="350" y1="200" x2="350" y2="380" stroke="rgba(0,0,0,0.3)" />
        <line x1="180" y1="290" x2="520" y2="290" stroke="rgba(0,0,0,0.25)" />

        {eaves.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            stroke="#34d399"
            strokeWidth="3.5"
            strokeLinecap="round"
            fill="none"
            initial={{ pathLength: 0, opacity: 0 }}
            whileInView={{ pathLength: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.9, delay: 0.2 + i * 0.18, ease: "easeOut" }}
            style={{ filter: "drop-shadow(0 0 6px rgba(52,211,153,0.55))" }}
          />
        ))}

        {[
          { x: 180, y: 240 },
          { x: 520, y: 240 },
          { x: 180, y: 360 },
          { x: 520, y: 360 },
          { x: 660, y: 350 },
        ].map((d, i) => (
          <motion.g
            key={`ds-${i}`}
            initial={{ scale: 0, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 1.2 + i * 0.1, type: "spring", stiffness: 240 }}
          >
            <circle cx={d.x} cy={d.y} r="8" fill="#0a0d14" stroke="#22d3ee" strokeWidth="2" />
            <circle cx={d.x} cy={d.y} r="3" fill="#22d3ee" />
          </motion.g>
        ))}
      </svg>

      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2">
        <Badge>Live takeoff</Badge>
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs text-zinc-300 backdrop-blur">
          <span className="h-2 w-2 animate-pulse-soft rounded-full bg-accent-400" />
          AI confidence 96%
        </div>
      </div>
    </div>
  );
}

function SummaryMock() {
  const rows = [
    { label: "6\" K-Style Aluminum", qty: "160 LF", price: "$1,920" },
    { label: "3×4 Downspouts", qty: "100 LF", price: "$900" },
    { label: "Outside Corners", qty: "6 ea", price: "$132" },
    { label: "Hidden Hangers", qty: "80 ea", price: "$260" },
    { label: "Labor & Install", qty: "1 lot", price: "$1,360" },
  ];

  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-ink-900/80 p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-zinc-500">
          Material takeoff
        </span>
        <Badge tone="neutral">Auto-generated</Badge>
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-display text-4xl font-semibold tracking-tight">
          $4,572
        </span>
        <span className="text-sm text-zinc-500">est. total</span>
      </div>
      <div className="mt-4 space-y-2.5">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm"
          >
            <span className="text-zinc-300">{r.label}</span>
            <div className="flex items-center gap-3 text-zinc-500">
              <span>{r.qty}</span>
              <span className="font-medium text-zinc-200">{r.price}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-3 gap-2 text-center text-xs text-zinc-500">
        <Stat label="Eaves" value="148 LF" />
        <Stat label="Downspouts" value="5" />
        <Stat label="Stories" value="2" />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-2.5">
      <div className="text-zinc-200 text-sm font-medium">{value}</div>
      <div className="mt-0.5 uppercase tracking-wider">{label}</div>
    </div>
  );
}
