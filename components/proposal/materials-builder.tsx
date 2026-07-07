"use client";

import { useMemo } from "react";
import {
  Layers,
  Plus,
  Receipt,
  RotateCcw,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { buildLineItems } from "@/lib/pricing";
import {
  markupPctForTarget,
  packageTotal,
  type AddOn,
  type Package,
} from "@/lib/proposal-mock";
import type { EstimateConfig, LineItem, Measurements } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

const NUM_INPUT =
  "w-14 shrink-0 rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-right text-xs tabular-nums outline-none transition focus:border-accent-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
import { MaterialSelector } from "@/components/estimate/material-selector";
import { EditablePrice } from "./editable-price";

const STYLE_LABEL: Record<EstimateConfig["style"], string> = {
  "k-style": "K-style",
  "half-round": "half-round",
};
const MATERIAL_LABEL: Record<EstimateConfig["material"], string> = {
  aluminum: "aluminum",
  steel: "steel",
  copper: "copper",
};
const DOWNSPOUT_LABEL: Record<EstimateConfig["downspoutSize"], string> = {
  "2x3": '2"×3"',
  "3x4": '3"×4"',
  "round-3": '3" round',
  "round-4": '4" round',
};

/**
 * Suggested client-facing spec bullets derived from the live material
 * config — surfaced as one-tap chips so the contractor can keep the
 * "what's included" list in sync with what they actually picked without
 * blowing away hand-written lines (warranty, inspections, etc.).
 */
function specChipsFromConfig(config: EstimateConfig): string[] {
  const chips = [
    `${config.size}" ${STYLE_LABEL[config.style]} ${MATERIAL_LABEL[config.material]} gutters`,
    `${DOWNSPOUT_LABEL[config.downspoutSize]} downspouts`,
  ];
  const acc = config.accessories;
  if (acc) {
    if (acc.guard !== "none") {
      chips.push(
        acc.guard === "screen"
          ? "Screen leaf guards"
          : acc.guard === "mesh"
            ? "Mesh leaf guards"
            : "Micro-mesh leaf guards",
      );
    }
    if (acc.dripEdge) chips.push("Aluminum drip-edge flashing");
    if (acc.rainChain) chips.push("Decorative copper rain chain");
    if (acc.iceGuard) chips.push("Snow / ice guards");
    if (acc.heatTape) chips.push("Heat-tape ice-dam kit");
  }
  return chips;
}

/**
 * Full "go back to the builder" materials editor for a single proposal
 * package — the same Materials experience as the post-analyze estimate
 * builder ([PricingPanel]) reused here, plus the client-facing spec
 * bullets, add-ons, a live bill of materials, and price. Renders as a
 * right slide-over so it can be launched from either the editor or the
 * preview's edit drawer; the parent owns the package and patches it
 * through `onChange`.
 */
export function MaterialsBuilder({
  pkg,
  measurements,
  discountPct,
  onChange,
  onClose,
}: {
  pkg: Package;
  measurements: Measurements;
  discountPct: number;
  onChange: (next: Package) => void;
  onClose: () => void;
}) {
  const totals = useMemo(
    () => packageTotal(pkg, measurements, discountPct),
    [pkg, measurements, discountPct],
  );
  const autoBase = useMemo(
    () => buildLineItems(measurements, pkg.config),
    [measurements, pkg.config],
  );
  const overrides = pkg.lineItemOverrides ?? {};
  const custom = pkg.customLineItems ?? [];

  const set = (patch: Partial<Package>) => onChange({ ...pkg, ...patch });
  const setHighlights = (highlights: string[]) => set({ highlights });
  const setAddOns = (addOns: AddOn[]) => set({ addOns });
  const setCustom = (items: LineItem[]) => set({ customLineItems: items });

  const setOverride = (
    id: string,
    patch: { quantity?: number; unitPrice?: number },
  ) => {
    const next = { ...(pkg.lineItemOverrides ?? {}) };
    next[id] = { ...(next[id] ?? {}), ...patch };
    set({ lineItemOverrides: next });
  };
  const clearOverride = (id: string) => {
    if (!pkg.lineItemOverrides?.[id]) return;
    const next = { ...pkg.lineItemOverrides };
    delete next[id];
    set({
      lineItemOverrides: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  const suggestions = specChipsFromConfig(pkg.config).filter(
    (s) => !pkg.highlights.includes(s),
  );

  return (
    <div className="fixed inset-0 z-50 print:hidden">
      <button
        type="button"
        aria-label="Close materials builder"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40"
      />
      <aside className="absolute right-0 top-0 flex h-full w-[600px] max-w-[96vw] flex-col border-l border-zinc-200 bg-zinc-50 shadow-elevated">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-label text-[10px] text-accent-700">
              Materials builder
            </div>
            <input
              value={pkg.name}
              onChange={(e) => set({ name: e.target.value })}
              aria-label="Package name"
              className="w-full bg-transparent text-lg font-semibold tracking-tight text-zinc-900 outline-none"
            />
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tracking-tight tabular-nums text-zinc-900">
              {formatCurrency(totals.total)}
            </div>
            <div className="text-[11px] text-zinc-500">
              {pkg.markupPct.toFixed(1)}% markup
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <Section
            icon={Layers}
            title="Materials & spec"
            sub="Pick the gutter system. Price, preview, and bill of materials update live."
          >
            <MaterialSelector
              config={pkg.config}
              onChange={(config) => set({ config })}
            />
          </Section>

          <Section
            icon={Sparkles}
            title="What's included"
            sub="The bullet list the client reads under this package."
          >
            <ul className="space-y-1.5">
              {pkg.highlights.map((h, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    value={h}
                    onChange={(e) =>
                      setHighlights(
                        pkg.highlights.map((x, j) =>
                          j === i ? e.target.value : x,
                        ),
                      )
                    }
                    className="flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/15"
                  />
                  <button
                    type="button"
                    aria-label="Remove line"
                    onClick={() =>
                      setHighlights(pkg.highlights.filter((_, j) => j !== i))
                    }
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-400 transition hover:border-rose-300 hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setHighlights([...pkg.highlights, ""])}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-700 transition hover:text-accent-900"
            >
              <Plus className="h-3.5 w-3.5" />
              Add line
            </button>
            {suggestions.length > 0 && (
              <div className="mt-3 rounded-xl border border-dashed border-zinc-200 bg-white/60 p-3">
                <div className="font-label text-[10px] text-zinc-500">
                  From your materials — tap to add
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setHighlights([...pkg.highlights, s])}
                      className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700 transition hover:border-accent-400 hover:text-accent-700"
                    >
                      + {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>

          <Section icon={Tag} title="Add-ons" sub="Optional upgrades on this tier.">
            <ul className="space-y-1.5">
              {pkg.addOns.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={a.included}
                    onChange={(e) =>
                      setAddOns(
                        pkg.addOns.map((x) =>
                          x.id === a.id
                            ? { ...x, included: e.target.checked }
                            : x,
                        ),
                      )
                    }
                    className="h-4 w-4 rounded border-zinc-300 accent-accent-600"
                  />
                  <input
                    value={a.name}
                    onChange={(e) =>
                      setAddOns(
                        pkg.addOns.map((x) =>
                          x.id === a.id ? { ...x, name: e.target.value } : x,
                        ),
                      )
                    }
                    className="flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/15"
                  />
                  <div className="flex items-center gap-1 text-sm text-zinc-600">
                    <span className="text-zinc-400">$</span>
                    <input
                      type="number"
                      step={5}
                      value={a.price}
                      onChange={(e) =>
                        setAddOns(
                          pkg.addOns.map((x) =>
                            x.id === a.id
                              ? { ...x, price: parseFloat(e.target.value) || 0 }
                              : x,
                          ),
                        )
                      }
                      className="w-16 rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-right text-sm tabular-nums outline-none focus:border-accent-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <button
                    type="button"
                    aria-label="Remove add-on"
                    onClick={() =>
                      setAddOns(pkg.addOns.filter((x) => x.id !== a.id))
                    }
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-400 transition hover:border-rose-300 hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                setAddOns([
                  ...pkg.addOns,
                  {
                    id: `addon-${pkg.addOns.length + 1}-${pkg.id}`,
                    name: "New add-on",
                    price: 0,
                    included: false,
                  },
                ])
              }
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-700 transition hover:text-accent-900"
            >
              <Plus className="h-3.5 w-3.5" />
              Add add-on
            </button>
          </Section>

          <Section
            icon={Receipt}
            title="Bill of materials"
            sub="Auto-generated from the spec — override a quantity or price, or add your own line."
          >
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              {autoBase.map((it) => {
                const ov = overrides[it.id];
                const qty = ov?.quantity ?? it.quantity;
                const price = ov?.unitPrice ?? it.unitPrice;
                const overridden =
                  ov?.quantity !== undefined || ov?.unitPrice !== undefined;
                return (
                  <div
                    key={it.id}
                    className="flex items-center gap-1.5 border-b border-zinc-100 px-3 py-2 text-xs last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-zinc-800">
                        {it.name}
                        {overridden && (
                          <span className="ml-1 text-[10px] font-normal text-accent-600">
                            edited
                          </span>
                        )}
                      </div>
                      {it.description && (
                        <div className="truncate text-[11px] text-zinc-500">
                          {it.description}
                        </div>
                      )}
                    </div>
                    <input
                      type="number"
                      aria-label={`${it.name} quantity`}
                      value={qty}
                      onChange={(e) =>
                        setOverride(it.id, {
                          quantity: Math.max(0, parseFloat(e.target.value) || 0),
                        })
                      }
                      className={NUM_INPUT}
                    />
                    <span className="w-6 shrink-0 text-[11px] text-zinc-400">
                      {it.unit}
                    </span>
                    <span className="text-zinc-400">$</span>
                    <input
                      type="number"
                      step={0.25}
                      aria-label={`${it.name} unit price`}
                      value={price}
                      onChange={(e) =>
                        setOverride(it.id, {
                          unitPrice: Math.max(
                            0,
                            parseFloat(e.target.value) || 0,
                          ),
                        })
                      }
                      className={NUM_INPUT}
                    />
                    <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-zinc-900">
                      {formatCurrency(qty * price)}
                    </span>
                    <button
                      type="button"
                      aria-label="Reset to auto"
                      title="Reset to auto value"
                      disabled={!overridden}
                      onClick={() => clearOverride(it.id)}
                      className={cn(
                        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-300 transition",
                        overridden
                          ? "hover:bg-zinc-100 hover:text-zinc-600"
                          : "opacity-30",
                      )}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}

              {custom.map((it, i) => (
                <div
                  key={it.id}
                  className="flex items-center gap-1.5 border-b border-zinc-100 bg-amber-50/30 px-3 py-2 text-xs last:border-0"
                >
                  <input
                    aria-label="Custom line name"
                    value={it.name}
                    onChange={(e) =>
                      setCustom(
                        custom.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x,
                        ),
                      )
                    }
                    className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none transition focus:border-accent-500"
                  />
                  <input
                    type="number"
                    aria-label="Custom line quantity"
                    value={it.quantity}
                    onChange={(e) =>
                      setCustom(
                        custom.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                quantity: Math.max(
                                  0,
                                  parseFloat(e.target.value) || 0,
                                ),
                              }
                            : x,
                        ),
                      )
                    }
                    className={NUM_INPUT}
                  />
                  <input
                    aria-label="Custom line unit"
                    value={it.unit}
                    onChange={(e) =>
                      setCustom(
                        custom.map((x, j) =>
                          j === i ? { ...x, unit: e.target.value } : x,
                        ),
                      )
                    }
                    className="w-8 shrink-0 rounded-md border border-zinc-200 bg-white px-1 py-1 text-center text-[11px] outline-none transition focus:border-accent-500"
                  />
                  <span className="text-zinc-400">$</span>
                  <input
                    type="number"
                    step={0.25}
                    aria-label="Custom line unit price"
                    value={it.unitPrice}
                    onChange={(e) =>
                      setCustom(
                        custom.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                unitPrice: Math.max(
                                  0,
                                  parseFloat(e.target.value) || 0,
                                ),
                              }
                            : x,
                        ),
                      )
                    }
                    className={NUM_INPUT}
                  />
                  <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-zinc-900">
                    {formatCurrency(it.quantity * it.unitPrice)}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove custom line"
                    onClick={() => setCustom(custom.filter((_, j) => j !== i))}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}

              <div className="flex items-center justify-between bg-zinc-50/60 px-3 py-2 text-xs font-semibold">
                <span className="text-zinc-700">Materials + labor subtotal</span>
                <span className="tabular-nums text-zinc-900">
                  {formatCurrency(totals.subtotal)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setCustom([
                  ...custom,
                  {
                    id: `custom-${custom.length + 1}-${pkg.id}`,
                    name: "Custom line",
                    description: "",
                    quantity: 1,
                    unit: "ea",
                    unitPrice: 0,
                    taxable: true,
                  },
                ])
              }
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-700 transition hover:text-accent-900"
            >
              <Plus className="h-3.5 w-3.5" />
              Add custom line
            </button>
          </Section>

          <Section title="Price">
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-sm">
              <label className="flex items-center gap-1.5 text-zinc-600">
                Markup
                <input
                  type="number"
                  step={0.5}
                  value={Math.round(pkg.markupPct * 10) / 10}
                  onChange={(e) =>
                    set({ markupPct: parseFloat(e.target.value) || 0 })
                  }
                  className="w-16 rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-right text-sm tabular-nums outline-none focus:border-accent-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                %
              </label>
              <div className="ml-auto flex items-baseline gap-1.5 text-zinc-600">
                <span>Total</span>
                <EditablePrice
                  total={totals.total}
                  onCommit={(target) =>
                    set({
                      markupPct: markupPctForTarget(
                        target,
                        totals.subtotal,
                        discountPct,
                      ),
                    })
                  }
                  className="text-lg font-semibold tracking-tight tabular-nums text-zinc-900"
                />
              </div>
            </div>
          </Section>
        </div>

        <div className="border-t border-zinc-200 bg-white px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-accent-500"
          >
            Done
          </button>
        </div>
      </aside>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  sub,
  children,
}: {
  icon?: typeof Layers;
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
        {Icon && <Icon className="h-4 w-4 text-accent-600" />}
        {title}
      </div>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
