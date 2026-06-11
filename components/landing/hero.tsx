"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Award,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Timer,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AddressInput } from "./address-input";
import { MiniDemo } from "./mini-demo";
import { DemoFlow } from "./demo-flow";
import { SAMPLE_ADDRESS } from "@/lib/mock-estimate";

/**
 * Two-column hero:
 *   • LEFT  — badge + headline + subtitle + AddressInput + social proof + stat strip
 *   • RIGHT — always-on looping aerial mini-demo (click to open full demo)
 *
 * Both AddressInput and MiniDemo open the same DemoFlow modal, which
 * is mounted here at the Hero level so its state can be shared.
 */
export function Hero() {
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoAddress, setDemoAddress] = useState("");

  function openDemo(addr: string) {
    setDemoAddress(addr || SAMPLE_ADDRESS);
    setDemoOpen(true);
  }

  return (
    <section className="relative overflow-hidden pt-24 pb-16 sm:pt-32 sm:pb-24">
      {/* Layered background */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid opacity-50 [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_75%)]" />
        <div className="absolute -top-40 left-1/3 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-accent-200/45 blur-3xl" />
        <div className="absolute right-1/4 top-12 h-[300px] w-[460px] rounded-full bg-sky-200/40 blur-3xl" />
        <div className="absolute left-1/4 top-48 h-[220px] w-[340px] rounded-full bg-emerald-200/35 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white to-transparent" />
      </div>

      <div className="mx-auto max-w-7xl px-4 lg:px-6">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-14 xl:gap-20">
          {/* ─── LEFT COLUMN ─────────────────────────────────────── */}
          <div className="text-center lg:text-left">
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex justify-center lg:justify-start"
            >
              <Badge>
                <Sparkles className="h-3 w-3" />
                Built for gutter contractors
              </Badge>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.05 }}
              className="font-display mt-5 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-zinc-900 sm:text-5xl lg:text-[3.5rem] xl:text-6xl"
            >
              Address in.{" "}
              <span className="text-gradient">Signed proposal</span> out.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="mt-5 max-w-xl text-balance text-base text-zinc-600 sm:text-lg lg:mx-0 mx-auto"
            >
              Our AI measures the eaves, places downspouts, and assembles a
              branded, sign-and-pay proposal — in under{" "}
              <strong className="text-zinc-900">60 seconds</strong>.
            </motion.p>

            <div className="mt-7">
              <AddressInput onOpenDemo={openDemo} />
            </div>

            {/* Social proof + trust line */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="mt-6 flex flex-col items-center gap-3 lg:flex-row lg:items-center lg:justify-start lg:gap-5"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex -space-x-2">
                  {AVATARS.map((a) => (
                    <span
                      key={a.label}
                      title={a.label}
                      style={{ background: a.bg }}
                      className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white shadow-sm"
                    >
                      {a.initials}
                    </span>
                  ))}
                  <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-zinc-900 text-[9px] font-semibold text-white shadow-sm">
                    +1k
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex">
                    {Array.from({ length: 5 }, (_, i) => (
                      <Star
                        key={i}
                        className="h-3 w-3 fill-amber-400 text-amber-400"
                      />
                    ))}
                  </div>
                  <span className="text-xs text-zinc-600">
                    <strong className="text-zinc-900">4.9/5</strong> · 1k+
                    contractors
                  </span>
                </div>
              </div>
              <span className="hidden h-4 w-px bg-zinc-300 lg:block" />
              <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                Stripe-secured · SOC 2 in progress
              </div>
            </motion.div>

            {/* Compact stat strip */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="mt-7 grid grid-cols-3 gap-2"
            >
              <StatPill
                icon={Timer}
                value="< 60 sec"
                label="Address → proposal"
                tone="accent"
              />
              <StatPill
                icon={Target}
                value="±2%"
                label="LF accuracy"
                tone="cyan"
              />
              <StatPill
                icon={Award}
                value="10,000+"
                label="Estimates run"
                tone="amber"
              />
            </motion.div>
          </div>

          {/* ─── RIGHT COLUMN: looping mini-demo ─────────────────── */}
          <div className="relative">
            <MiniDemo onOpenFullDemo={() => openDemo("")} />
          </div>
        </div>
      </div>

      <DemoFlow
        open={demoOpen}
        address={demoAddress}
        onClose={() => setDemoOpen(false)}
      />
    </section>
  );
}

const AVATARS = [
  {
    initials: "MR",
    label: "Mike R.",
    bg: "linear-gradient(135deg,#22c55e,#0ea5e9)",
  },
  {
    initials: "JT",
    label: "Jess T.",
    bg: "linear-gradient(135deg,#f59e0b,#ef4444)",
  },
  {
    initials: "DK",
    label: "Dan K.",
    bg: "linear-gradient(135deg,#8b5cf6,#ec4899)",
  },
];

function StatPill({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof Timer;
  value: string;
  label: string;
  tone: "accent" | "cyan" | "amber";
}) {
  const toneClass =
    tone === "accent"
      ? "bg-accent-50 text-accent-700 ring-accent-200"
      : tone === "cyan"
        ? "bg-cyan-50 text-cyan-700 ring-cyan-200"
        : "bg-amber-50 text-amber-700 ring-amber-200";
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white/70 px-2.5 py-2 text-left shadow-sm backdrop-blur">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${toneClass}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <div className="font-display text-sm font-semibold tracking-tight text-zinc-900 tabular-nums">
          {value}
        </div>
        <div className="truncate text-[9px] uppercase tracking-wider text-zinc-500">
          {label}
        </div>
      </div>
    </div>
  );
}
