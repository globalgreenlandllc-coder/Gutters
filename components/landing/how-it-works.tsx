"use client";

import { motion } from "framer-motion";

const STEPS = [
  {
    n: "01",
    title: "Geocode & fetch aerial",
    body: "We resolve the address and pull high-resolution aerial imagery + roof pitch data.",
  },
  {
    n: "02",
    title: "Segment the eaves",
    body: "Vision AI traces gutter-bearing edges and reports total linear feet with corner counts.",
  },
  {
    n: "03",
    title: "Place the downspouts",
    body: "Heuristic engine drops 1 downspout per ~35 LF, preferring outside corners + low elevations.",
  },
  {
    n: "04",
    title: "Send & get paid",
    body: "Adjust scope, send the proposal, the homeowner accepts and pays — funds land in your Stripe.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="relative mx-auto max-w-7xl px-4 py-24">
      <div className="mb-12 max-w-2xl">
        <h2 className="font-display text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          From address to accepted in four steps.
        </h2>
        <p className="mt-3 text-zinc-400">
          The pipeline runs in parallel server-side, so the contractor sees an
          editable estimate seconds after typing the address.
        </p>
      </div>

      <ol className="relative grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <motion.li
            key={s.n}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.5, delay: i * 0.06 }}
            className="group relative rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-accent-400/30"
          >
            <span className="font-display text-3xl font-semibold tracking-tight text-accent-300/90">
              {s.n}
            </span>
            <h3 className="font-display mt-3 text-lg font-semibold tracking-tight">
              {s.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {s.body}
            </p>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}
