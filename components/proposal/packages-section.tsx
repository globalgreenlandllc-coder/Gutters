"use client";

import { Check, Plus, Sparkles, Star } from "lucide-react";
import { motion } from "framer-motion";
import { cn, formatCurrency } from "@/lib/utils";
import {
  packageTotal,
  type Package,
  type Proposal,
} from "@/lib/proposal-mock";

export function PackagesSection({
  proposal,
  onChange,
  readOnly,
  selectedPackageId,
  onSelectPackage,
}: {
  proposal: Proposal;
  onChange: (p: Proposal) => void;
  readOnly?: boolean;
  selectedPackageId?: string | null;
  onSelectPackage?: (id: string) => void;
}) {
  function update(id: string, patch: Partial<Package>) {
    onChange({
      ...proposal,
      packages: proposal.packages.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    });
  }

  return (
    <section data-section="packages" className="space-y-4">
      <SectionHeader
        title="Choose your package"
        sub="Each tier is sized to your roof. The middle option is most popular."
        readOnly={readOnly}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {proposal.packages.map((p) => {
          const totals = packageTotal(p, proposal.measurements);
          const selected = selectedPackageId === p.id;
          const interactive = !!onSelectPackage;
          return (
            <motion.div
              key={p.id}
              whileHover={interactive ? { y: -2 } : undefined}
              className={cn(
                "relative flex flex-col overflow-hidden rounded-2xl border bg-gradient-to-b p-6 transition",
                selected
                  ? "border-accent-400/60 from-accent-500/[0.08] to-transparent shadow-glow"
                  : p.recommended
                  ? "border-accent-400/30 from-accent-500/[0.04] to-transparent"
                  : "border-white/10 from-white/[0.03] to-transparent",
                interactive && !selected && "cursor-pointer hover:border-white/25",
              )}
              onClick={interactive ? () => onSelectPackage(p.id) : undefined}
            >
              {p.recommended && (
                <div className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-accent-400/30 bg-accent-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent-300">
                  <Star className="h-2.5 w-2.5" />
                  Most popular
                </div>
              )}

              {readOnly ? (
                <h3 className="font-display text-xl font-semibold tracking-tight text-zinc-100">
                  {p.name}
                </h3>
              ) : (
                <input
                  value={p.name}
                  onChange={(e) => update(p.id, { name: e.target.value })}
                  className="font-display w-full bg-transparent text-xl font-semibold tracking-tight text-zinc-100 outline-none focus:text-white"
                />
              )}

              {readOnly ? (
                <p className="mt-1 text-sm text-zinc-400">{p.tagline}</p>
              ) : (
                <input
                  value={p.tagline}
                  onChange={(e) => update(p.id, { tagline: e.target.value })}
                  className="mt-1 w-full bg-transparent text-sm text-zinc-400 outline-none focus:text-zinc-200"
                />
              )}

              <div className="mt-5 flex items-baseline gap-2">
                <motion.span
                  key={Math.round(totals.total)}
                  initial={{ opacity: 0.5, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="font-display text-3xl font-semibold tracking-tight tabular-nums"
                >
                  {formatCurrency(totals.total)}
                </motion.span>
                <span className="text-xs text-zinc-500">total</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {formatCurrency(totals.subtotal)} subtotal · {p.markupPct}% markup
              </div>

              <ul className="mt-5 space-y-2">
                {p.highlights.map((h, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-zinc-300"
                  >
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-400" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              {p.addOns.length > 0 && (
                <div className="mt-5 border-t border-white/[0.06] pt-4">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Add-ons
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {p.addOns.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <label className="flex flex-1 items-center gap-2 text-zinc-300">
                          <input
                            type="checkbox"
                            checked={a.included}
                            disabled={readOnly && !interactive}
                            onChange={(e) =>
                              update(p.id, {
                                addOns: p.addOns.map((x) =>
                                  x.id === a.id
                                    ? { ...x, included: e.target.checked }
                                    : x,
                                ),
                              })
                            }
                            className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.06] accent-accent-400"
                          />
                          <span>{a.name}</span>
                        </label>
                        <span
                          className={cn(
                            "tabular-nums",
                            a.included
                              ? "text-accent-300"
                              : "text-zinc-500",
                          )}
                        >
                          {a.price === 0 ? "Included" : formatCurrency(a.price)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {interactive && (
                <button
                  type="button"
                  className={cn(
                    "mt-5 inline-flex h-10 items-center justify-center gap-1.5 rounded-xl text-sm font-medium transition",
                    selected
                      ? "bg-gradient-to-b from-accent-400 to-accent-500 text-ink-950 shadow-glow"
                      : "border border-white/15 text-zinc-200 hover:border-accent-400/40 hover:text-accent-300",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectPackage(p.id);
                  }}
                >
                  {selected ? (
                    <>
                      <Check className="h-4 w-4" />
                      Selected
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Choose {p.name}
                    </>
                  )}
                </button>
              )}

              {!readOnly && !interactive && (
                <div className="mt-5 flex items-center gap-2 text-xs text-zinc-500">
                  <span>Markup</span>
                  <input
                    type="number"
                    step={0.5}
                    value={p.markupPct}
                    onChange={(e) =>
                      update(p.id, { markupPct: parseFloat(e.target.value) || 0 })
                    }
                    className="h-7 w-14 rounded-md border border-white/10 bg-white/[0.02] px-1.5 text-right text-xs text-zinc-200 outline-none focus:border-accent-400/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span>%</span>
                  <button
                    type="button"
                    onClick={() =>
                      update(p.id, { recommended: !p.recommended })
                    }
                    className="ml-auto rounded-md border border-white/10 px-2 py-1 text-zinc-300 transition hover:border-accent-400/40 hover:text-accent-300"
                  >
                    {p.recommended ? "Unmark popular" : "Mark popular"}
                  </button>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

export function SectionHeader({
  title,
  sub,
  readOnly,
  action,
}: {
  title: string;
  sub?: string;
  readOnly?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {title}
        </h2>
        {sub && <p className="mt-1 text-sm text-zinc-400">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
