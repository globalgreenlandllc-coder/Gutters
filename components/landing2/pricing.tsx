import Link from "next/link";
import { Check } from "lucide-react";
import { Container, SectionHeader, PillLink } from "./ui";
import { Reveal } from "./reveal";

/**
 * Plan values are hardcoded from lib/stripe.ts (server-only module — the
 * landing can't import it): Pro $50/mo with 12 takeoffs, credit packs
 * 5/$25 · 10/$45 · 25/$100, free 10× re-runs per address in 24h.
 */
const FEATURES = [
  "12 AI takeoffs every month",
  "Satellite + blueprint takeoffs",
  "Re-run the same address 10× in 24h — free",
  "Drag-to-edit takeoff canvas + downspout placement",
  "Good · Better · Best proposal builder",
  "Payment schedules, receipts & reminders",
  "Branded client portal + e-sign",
  "Crew scheduling & worker portal",
];

const PACKS = [
  { qty: "5 takeoffs", price: "$25", per: "$5.00 / estimate" },
  { qty: "10 takeoffs", price: "$45", per: "$4.50 / estimate" },
  { qty: "25 takeoffs", price: "$100", per: "$4.00 / estimate" },
];

export function Pricing() {
  return (
    <section id="pricing" className="bg-paper py-24 md:py-32">
      <Container>
        <Reveal>
          <SectionHeader
            eyebrow="Pricing"
            title={
              <>
                One plan that pays for itself
                <br />
                on the first job.
              </>
            }
            copy="Every takeoff is a measured, sendable proposal — twelve of them are included every month."
          />
        </Reveal>

        <Reveal className="mt-14" delay={0.05}>
          <div className="mx-auto grid max-w-[980px] gap-6 lg:grid-cols-[1fr_360px]">
            <div className="rounded-3xl border border-zinc-200/70 bg-white p-8 shadow-card">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-accent-600">
                GutterScan Pro
              </p>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-2">
                <span className="text-[44px] font-semibold leading-none tracking-tight text-zinc-900">
                  $50
                </span>
                <span className="text-[15px] text-zinc-500">/ month</span>
                <span className="ml-2 self-center rounded-full bg-accent-50 px-2.5 py-1 text-[11px] font-semibold text-accent-700">
                  14 days free
                </span>
              </div>

              <ul className="mt-7 grid grid-cols-1 sm:grid-cols-2 sm:gap-x-8">
                {FEATURES.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2 border-t border-zinc-200/70 py-2.5 text-sm text-zinc-700"
                  >
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-zinc-200/70 pt-6">
                <PillLink href="/sign-up" variant="dark">
                  Start free trial
                </PillLink>
                <Link
                  href="/sign-in"
                  className="inline-flex h-11 items-center justify-center rounded-lg px-4 text-[13px] font-semibold text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800"
                >
                  Sign in
                </Link>
                <span className="text-xs text-zinc-400 sm:ml-auto">
                  Cancel anytime · No card to start
                </span>
              </div>
            </div>

            <div className="flex flex-col rounded-3xl bg-accent-950 p-6 text-white">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">
                Need more takeoffs
              </p>
              <h3 className="mt-2 text-[18px] font-semibold tracking-tight">
                Top up anytime
              </h3>
              <ul className="mt-4 divide-y divide-white/10">
                {PACKS.map((p) => (
                  <li key={p.qty} className="py-3.5 first:pt-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-semibold">{p.qty}</p>
                      <p className="text-sm font-semibold tabular-nums">
                        {p.price}
                      </p>
                    </div>
                    <p className="mt-0.5 text-xs text-white/50">{p.per}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-auto pt-5 text-xs leading-relaxed text-white/40">
                Credits never interrupt your subscription — they stack on top.
              </p>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
