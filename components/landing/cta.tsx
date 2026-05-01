"use client";

import { motion } from "framer-motion";
import { AddressInput } from "./address-input";
import { Badge } from "@/components/ui/badge";

export function CTA() {
  return (
    <section className="relative mx-auto max-w-7xl px-4 pb-24">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.6 }}
        className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-ink-850 to-ink-900 p-8 text-center sm:p-14"
      >
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-30 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_70%)]" />
        <div className="pointer-events-none absolute -top-20 left-1/2 h-[300px] w-[600px] -translate-x-1/2 rounded-full bg-accent-500/15 blur-3xl" />

        <div className="relative">
          <Badge>Ready when you are</Badge>
          <h2 className="font-display mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            Type an address. Watch the estimate{" "}
            <span className="text-gradient">build itself.</span>
          </h2>
          <div className="mt-8">
            <AddressInput />
          </div>
        </div>
      </motion.div>
    </section>
  );
}
