"use client";

import { motion } from "framer-motion";
import {
  Check,
  CreditCard,
  Lock,
  Ruler,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

/**
 * Hero showcase: three product surfaces stacked in a tilted "cascade",
 * sized to read on a phone but designed for the wow on desktop. Pure
 * HTML/CSS/SVG — no live data, no API calls, no flash of empty state.
 */
export function DashboardCascade() {
  return (
    <section className="relative isolate overflow-hidden bg-slate-950 py-24 sm:py-32">
      {/* Backdrop: subtle radial + scan grid for the premium tactical vibe */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.18),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(255,43,214,0.12),transparent_50%)]"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(103,232,249,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(103,232,249,0.6) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <div className="mx-auto max-w-7xl px-4 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-slate-900/60 px-3 py-1 text-xs font-medium text-cyan-200 backdrop-blur">
          <Sparkles className="h-3 w-3" />
          One workflow, address to deposit
        </span>
        <h2 className="font-display mt-5 text-balance text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          From <span className="text-gradient">aerial measurement</span> to{" "}
          <span className="text-gradient">paid invoice</span> in one tab.
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-balance text-base leading-relaxed text-slate-400">
          The AI sizes the roof, the proposal builder packages it three ways,
          and the homeowner pays from their phone. You never leave the app.
        </p>
      </div>

      {/* Cascade — uses CSS perspective for the 3D tilt */}
      <div
        className="relative mx-auto mt-16 max-w-6xl px-4"
        style={{ perspective: "1800px" }}
      >
        <div className="relative h-[640px] sm:h-[680px]">
          <BackTakeoffCard />
          <CenterProposalCard />
          <FrontPhoneCard />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*                       BACK CARD: AI takeoff                        */
/* ------------------------------------------------------------------ */

function BackTakeoffCard() {
  return (
    <motion.div
      initial={{ opacity: 0, x: -40, rotateY: 0 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.7, ease: "easeOut" }}
      className="absolute left-0 top-6 hidden w-[440px] sm:left-2 lg:block"
      style={{
        transform: "rotateY(18deg) rotateX(2deg) rotate(-4deg)",
        transformStyle: "preserve-3d",
      }}
    >
      <div className="rounded-2xl border border-slate-800 bg-slate-900/95 p-5 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.7)] backdrop-blur">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-slate-950/70 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cyan-200">
            <Ruler className="h-3 w-3" />
            AI takeoff
          </span>
          <span className="text-[10px] text-slate-500">98% confidence</span>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat label="Eaves" value="148 LF" tone="cyan" />
          <Stat label="Down­spouts" value="5" tone="magenta" />
          <Stat label="Stories" value="2" tone="cyan" />
        </div>

        <div className="mt-4 space-y-1.5">
          {[
            { label: "North eave (main)", val: "42 LF" },
            { label: "South eave (main)", val: "44 LF" },
            { label: "East wing — N", val: "18 LF" },
            { label: "East wing — S", val: "20 LF" },
            { label: "Front porch", val: "24 LF" },
          ].map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-950/60 px-2.5 py-1.5 text-[11px]"
            >
              <span className="text-slate-400">{r.label}</span>
              <span className="font-mono tabular-nums text-cyan-200">
                {r.val}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between text-[10px] text-slate-500">
          <span>Solar API · GPT-4o vision · SAM 2</span>
          <span className="font-mono">~12 sec</span>
        </div>
      </div>
    </motion.div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "cyan" | "magenta";
}) {
  const accent = tone === "cyan" ? "text-cyan-300" : "text-fuchsia-300";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-2 text-center">
      <div className={`font-mono text-base font-semibold tabular-nums ${accent}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*                CENTER CARD: Proposal builder packages              */
/* ------------------------------------------------------------------ */

function CenterProposalCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
      className="absolute left-1/2 top-0 w-[92%] max-w-[640px] -translate-x-1/2"
      style={{
        transform: "translateX(-50%) rotateX(2deg)",
        transformStyle: "preserve-3d",
      }}
    >
      <div className="rounded-3xl border border-white/10 bg-white p-5 shadow-[0_50px_100px_-20px_rgba(0,0,0,0.55)] sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Proposal builder
            </div>
            <div className="mt-0.5 text-sm font-medium text-zinc-900">
              6232 97th Dr NE · Lake Stevens, WA
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            <Check className="h-3 w-3" />
            Ready to send
          </span>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3">
          <PackageCard
            tier="Essential"
            price="$3,890"
            sub='5" K-style aluminum'
          />
          <PackageCard
            tier="Pro Shield"
            price="$4,572"
            sub='6" + micro-mesh guards'
            recommended
          />
          <PackageCard
            tier="Heritage"
            price="$8,940"
            sub="Half-round copper"
          />
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            {[
              { label: '6" K-Style Aluminum', qty: "160 LF", price: "$1,920" },
              { label: "3×4 Downspouts", qty: "100 LF", price: "$900" },
              { label: "Hidden Hangers", qty: "80 ea", price: "$260" },
              { label: "Labor & Install", qty: "1 lot", price: "$1,360" },
            ].map((r) => (
              <div
                key={r.label}
                className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-1.5 text-[11px] sm:text-xs"
              >
                <span className="text-zinc-700">{r.label}</span>
                <div className="flex items-center gap-3 text-zinc-500">
                  <span className="tabular-nums">{r.qty}</span>
                  <span className="w-14 text-right font-medium tabular-nums text-zinc-900">
                    {r.price}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 text-right">
            <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-700">
              Selected
            </div>
            <div className="font-display text-3xl font-semibold tracking-tight tabular-nums text-zinc-900">
              $4,572
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-500">
              30% deposit · pay-in-full available
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function PackageCard({
  tier,
  price,
  sub,
  recommended,
}: {
  tier: string;
  price: string;
  sub: string;
  recommended?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        recommended
          ? "border-emerald-300 bg-emerald-50/50 shadow-[0_0_0_3px_rgba(16,185,129,0.08)]"
          : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {tier}
        </span>
        {recommended && (
          <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-white">
            Picked
          </span>
        )}
      </div>
      <div className="mt-2 font-display text-xl font-semibold tabular-nums text-zinc-900">
        {price}
      </div>
      <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">
        {sub}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*                  FRONT CARD: Phone with Pay button                 */
/* ------------------------------------------------------------------ */

function FrontPhoneCard() {
  return (
    <motion.div
      initial={{ opacity: 0, x: 40 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.7, ease: "easeOut", delay: 0.2 }}
      className="absolute right-0 top-12 hidden w-[280px] sm:right-4 lg:block"
      style={{
        transform: "rotateY(-14deg) rotateX(3deg) rotate(5deg)",
        transformStyle: "preserve-3d",
      }}
    >
      <PhoneFrame>
        <div className="flex h-full flex-col bg-gradient-to-br from-white to-zinc-50">
          {/* Phone notch + status bar */}
          <div className="flex items-center justify-between px-5 pt-3 text-[9px] text-zinc-700">
            <span className="font-semibold">9:41</span>
            <div className="flex items-center gap-1 text-zinc-600">
              <span>●●●</span>
              <span>WiFi</span>
              <span>100%</span>
            </div>
          </div>

          {/* App content */}
          <div className="flex-1 px-4 pt-5">
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
              Rivera Gutterworks
            </div>
            <div className="mt-1 font-display text-xl font-semibold leading-tight text-zinc-900">
              Your gutter quote
            </div>
            <div className="mt-1 text-[10px] text-zinc-500">
              Locked for 30 days · 6232 97th Dr NE
            </div>

            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5">
              <div className="flex items-center justify-between text-[10px] text-zinc-500">
                <span>Selected · Pro Shield</span>
                <span>30% today</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-2xl font-semibold tabular-nums text-zinc-900">
                  $4,572
                </span>
                <span className="text-[10px] text-zinc-500">total</span>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[9px] text-zinc-500">
              <div className="rounded-md border border-zinc-200 bg-white px-1 py-1">
                <div className="font-semibold text-zinc-900">160 LF</div>
                <div>Eaves</div>
              </div>
              <div className="rounded-md border border-zinc-200 bg-white px-1 py-1">
                <div className="font-semibold text-zinc-900">5</div>
                <div>D-spouts</div>
              </div>
              <div className="rounded-md border border-zinc-200 bg-white px-1 py-1">
                <div className="font-semibold text-zinc-900">15-yr</div>
                <div>Warranty</div>
              </div>
            </div>
          </div>

          {/* Sticky pay CTA */}
          <div className="border-t border-zinc-200 bg-white/95 px-3 py-3 backdrop-blur">
            <button
              type="button"
              className="relative w-full overflow-hidden rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white shadow-[0_0_24px_rgba(16,185,129,0.65)]"
              tabIndex={-1}
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent [animation:cascadeShimmer_3s_ease_infinite]" />
              <span className="relative flex items-center justify-center gap-1.5">
                <Lock className="h-3 w-3" />
                Accept &amp; Pay $4,572
              </span>
            </button>
            <div className="mt-1.5 flex items-center justify-center gap-1 text-[8px] text-zinc-500">
              <ShieldCheck className="h-2.5 w-2.5 text-emerald-600" />
              Secured by Stripe · Funds direct to contractor
            </div>
          </div>
        </div>
      </PhoneFrame>

      <style jsx global>{`
        @keyframes cascadeShimmer {
          0% {
            transform: translateX(-100%);
          }
          50% {
            transform: translateX(100%);
          }
          100% {
            transform: translateX(100%);
          }
        }
      `}</style>
    </motion.div>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {/* Outer phone bezel */}
      <div className="relative h-[560px] w-[280px] rounded-[44px] bg-zinc-950 p-1.5 shadow-[0_50px_100px_-15px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.05)_inset]">
        {/* Inner screen */}
        <div className="relative h-full w-full overflow-hidden rounded-[36px] bg-white">
          {/* Dynamic-island-ish notch */}
          <div className="absolute left-1/2 top-1.5 z-10 h-5 w-20 -translate-x-1/2 rounded-full bg-zinc-950" />
          {children}
        </div>
      </div>

      {/* Pay button glow halo behind the phone */}
      <div
        aria-hidden
        className="absolute -bottom-8 left-1/2 -z-10 h-32 w-56 -translate-x-1/2 rounded-full bg-emerald-500/30 blur-3xl"
      />

      {/* Floating "Paid" notification */}
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.9 }}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={{ once: true, margin: "-200px" }}
        transition={{ delay: 1.2, type: "spring", stiffness: 240 }}
        className="absolute -right-6 top-32 hidden rounded-xl border border-emerald-200 bg-white px-3 py-2 shadow-[0_12px_24px_-8px_rgba(0,0,0,0.2)] xl:block"
      >
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
            <CreditCard className="h-3.5 w-3.5 text-emerald-700" />
          </div>
          <div>
            <div className="text-[10px] font-semibold text-zinc-900">
              Stripe · Payment received
            </div>
            <div className="text-[9px] text-zinc-500">
              $1,371.60 deposit · 6 sec ago
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
