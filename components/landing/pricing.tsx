"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight, Check, Repeat, Sparkles, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/auth-mock";

const FEATURES = [
  "12 AI takeoffs every month",
  "Re-run the same address 10× in 24h — free",
  "Drag-to-edit canvas + downspout placement",
  "Good · Better · Best proposal builder",
  "Stripe Connect payouts to your bank",
  "PDF export + branded client portal",
  "Unlimited contractors per company",
  "Email + chat support",
];

export function Pricing() {
  const { session } = useSession();
  const ctaHref = session ? "/dashboard" : "/sign-in?next=/dashboard";

  return (
    <section id="pricing" className="relative mx-auto max-w-7xl px-4 py-24">
      <div className="mb-14 flex flex-col items-center text-center">
        <Badge>
          <Sparkles className="h-3 w-3" />
          Simple, usage-based pricing
        </Badge>
        <h2 className="font-display mt-5 text-balance text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl md:text-5xl">
          One plan that{" "}
          <span className="text-gradient">pays for itself</span> on the first
          job.
        </h2>
        <p className="mt-4 max-w-2xl text-zinc-600">
          $50 a month gets you 12 estimates. Each address you run after that is
          $5. Re-run the same address up to ten times in 24 hours — at no extra
          charge.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.55 }}
          className="relative overflow-hidden rounded-3xl border border-accent-200 bg-gradient-to-br from-accent-50 via-white to-sky-50 p-8 shadow-elevated sm:p-10"
        >
          <div className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full bg-accent-300/30 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-12 left-1/3 h-40 w-40 rounded-full bg-sky-300/20 blur-3xl" />

          <div className="relative">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Badge>
                <Zap className="h-3 w-3" />
                Pro
              </Badge>
              <span className="text-xs text-zinc-500">
                Cancel anytime · No card to start
              </span>
            </div>

            <div className="mt-6 flex items-baseline gap-2">
              <span className="font-display text-6xl font-semibold tracking-tight text-zinc-900 tabular-nums">
                $50
              </span>
              <span className="text-zinc-500">/ month</span>
            </div>
            <p className="mt-1 text-sm text-zinc-600">
              <span className="font-medium text-zinc-900">12 credits</span>{" "}
              included · <span className="font-medium text-zinc-900">$5</span>{" "}
              per address after that
            </p>

            <ul className="mt-7 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2 text-sm text-zinc-700"
                >
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href={ctaHref}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-accent-600 px-6 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-700 active:translate-y-px sm:flex-1"
              >
                {session ? "Open dashboard" : "Start free trial"}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <span className="text-xs text-zinc-500">
                14 days free · then $50/month
              </span>
            </div>
          </div>
        </motion.div>

        <div className="space-y-3">
          <Tile
            badge={<><span className="font-semibold">$5</span> · per address</>}
            title="Add-on credits"
            body="Need more than 12 in a month? Each additional address is a flat $5 — billed at the end of the cycle."
          />
          <Tile
            icon={Repeat}
            badge="Free re-runs"
            title="Same address, 10× in 24h"
            body="Edits, re-pulls, and refinements on a single property are free. Each unique address counts as one credit."
          />
          <Tile
            badge="Free demo"
            title="Try it before you pay"
            body="Run a sample address from the dashboard with no credit card."
          />
        </div>
      </div>

      <p className="mt-8 text-center text-xs text-zinc-500">
        Need a higher volume team plan?{" "}
        <a
          href="mailto:hello@gutters.app"
          className="font-medium text-accent-700 hover:text-accent-800"
        >
          Talk to sales
        </a>
      </p>
    </section>
  );
}

function Tile({
  icon: Icon,
  badge,
  title,
  body,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  badge: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-600">
        {Icon && (
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-50 text-accent-700">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-zinc-700">
          {badge}
        </span>
      </div>
      <div className="mt-3 font-display text-base font-semibold tracking-tight text-zinc-900">
        {title}
      </div>
      <p className="mt-1 text-sm text-zinc-600">{body}</p>
    </motion.div>
  );
}
