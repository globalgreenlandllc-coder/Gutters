"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AddressInput } from "./address-input";

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="absolute -top-32 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-accent-500/10 blur-3xl" />
      </div>

      <div className="mx-auto max-w-7xl px-4 text-center">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex justify-center"
        >
          <Badge>
            <Sparkles className="h-3 w-3" />
            AI-powered gutter takeoff
          </Badge>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.05 }}
          className="font-display mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl"
        >
          Instant <span className="text-gradient">Gutter Takeoff</span>
          <br />
          from a single address.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="mx-auto mt-6 max-w-2xl text-balance text-lg text-zinc-400 sm:text-xl"
        >
          Type one address. Our AI measures eaves, places downspouts, and builds a
          professional proposal — ready for the homeowner to sign and pay.
        </motion.p>

        <div className="mt-10">
          <AddressInput />
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mx-auto mt-12 flex max-w-3xl flex-wrap items-center justify-center gap-x-10 gap-y-4 text-sm text-zinc-500"
        >
          <Stat value="< 60 sec" label="From address to proposal" />
          <Divider />
          <Stat value="±2%" label="LF accuracy vs ground truth" />
          <Divider />
          <Stat value="10,000+" label="Estimates generated" />
        </motion.div>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center sm:items-start">
      <span className="font-display text-2xl font-semibold tracking-tight text-zinc-100">
        {value}
      </span>
      <span className="mt-0.5 text-xs uppercase tracking-wider text-zinc-500">
        {label}
      </span>
    </div>
  );
}

function Divider() {
  return <span className="hidden h-8 w-px bg-white/10 sm:block" aria-hidden />;
}
