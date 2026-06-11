"use client";

import { motion } from "framer-motion";
import { Sparkles, Star, Timer, Target, Award } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AddressInput } from "./address-input";

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-20 sm:pt-36 sm:pb-28">
      {/* Layered background — grid + accent blob + cyan blob + soft top sheen */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid opacity-50 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="absolute -top-32 left-1/2 h-[440px] w-[860px] -translate-x-1/2 rounded-full bg-accent-200/45 blur-3xl" />
        <div className="absolute right-1/4 top-12 h-[260px] w-[400px] rounded-full bg-sky-200/35 blur-3xl" />
        <div className="absolute left-1/4 top-40 h-[200px] w-[320px] rounded-full bg-emerald-200/30 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white to-transparent" />
      </div>

      <div className="mx-auto max-w-7xl px-4 text-center">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex justify-center"
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
          className="font-display mt-6 text-balance text-5xl font-semibold leading-[1.04] tracking-tight text-zinc-900 sm:text-6xl md:text-7xl"
        >
          Instant <span className="text-gradient">Gutter Takeoff</span>
          <br />
          from a single address.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="mx-auto mt-6 max-w-2xl text-balance text-lg text-zinc-600 sm:text-xl"
        >
          Type one address. Our AI measures eaves, places downspouts, and builds
          a professional proposal — ready for the homeowner to sign and pay.
        </motion.p>

        <div className="mt-10">
          <AddressInput />
        </div>

        {/* Social proof — small avatar stack + rating sits under the
            input form so it carries the credibility punch right at
            the decision point. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.32 }}
          className="mx-auto mt-8 flex max-w-xl flex-col items-center justify-center gap-2 sm:flex-row sm:gap-4"
        >
          <div className="flex -space-x-2">
            {AVATARS.map((a) => (
              <span
                key={a.label}
                title={a.label}
                style={{ background: a.bg }}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-sm"
              >
                {a.initials}
              </span>
            ))}
            <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-zinc-900 text-[10px] font-semibold text-white shadow-sm">
              +1k
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex">
              {Array.from({ length: 5 }, (_, i) => (
                <Star
                  key={i}
                  className="h-3.5 w-3.5 fill-amber-400 text-amber-400"
                />
              ))}
            </div>
            <span className="text-sm text-zinc-600">
              <strong className="text-zinc-900">4.9/5</strong> from gutter pros
            </span>
          </div>
        </motion.div>

        {/* Stats — bigger, icon-led, with a card surface so they read
            as substantive numbers rather than running text. */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mx-auto mt-12 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3"
        >
          <StatCard
            icon={Timer}
            value="< 60 sec"
            label="Address → proposal"
            tone="accent"
          />
          <StatCard
            icon={Target}
            value="±2%"
            label="LF accuracy vs ground truth"
            tone="cyan"
          />
          <StatCard
            icon={Award}
            value="10,000+"
            label="Estimates generated"
            tone="amber"
          />
        </motion.div>
      </div>
    </section>
  );
}

const AVATARS = [
  { initials: "MR", label: "Mike R.", bg: "linear-gradient(135deg,#22c55e,#0ea5e9)" },
  { initials: "JT", label: "Jess T.", bg: "linear-gradient(135deg,#f59e0b,#ef4444)" },
  { initials: "DK", label: "Dan K.", bg: "linear-gradient(135deg,#8b5cf6,#ec4899)" },
  { initials: "SP", label: "Sara P.", bg: "linear-gradient(135deg,#06b6d4,#3b82f6)" },
];

function StatCard({
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
    <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white/70 px-4 py-3 text-left shadow-sm backdrop-blur">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${toneClass}`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="font-display text-xl font-semibold tracking-tight text-zinc-900 tabular-nums">
          {value}
        </div>
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">
          {label}
        </div>
      </div>
    </div>
  );
}
