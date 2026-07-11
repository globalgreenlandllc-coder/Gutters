import type { LineItem } from "@/lib/types";

// One totals pipeline for the whole estimate builder — the Summary tab,
// the live footer, and the material-chip price deltas must all agree to
// the cent, so they all call this.

export type Adjustments = {
  markupPct: number;
  discountPct: number;
  taxPct: number;
};

export type EstimateTotals = {
  subtotal: number;
  markup: number;
  discount: number;
  tax: number;
  total: number;
};

export function computeEstimateTotals(
  items: LineItem[],
  adj: Adjustments,
): EstimateTotals {
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const markup = subtotal * (adj.markupPct / 100);
  const afterMarkup = subtotal + markup;
  const discount = afterMarkup * (adj.discountPct / 100);
  const taxableBase = items
    .filter((i) => i.taxable)
    .reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const taxableAfterAdj =
    taxableBase * (1 + adj.markupPct / 100) * (1 - adj.discountPct / 100);
  const tax = taxableAfterAdj * (adj.taxPct / 100);
  const total = afterMarkup - discount + tax;
  return { subtotal, markup, discount, tax, total };
}

/** Compact signed currency for chip deltas: +$248, −$1.2k. Null when ~0. */
export function formatDelta(n: number): string | null {
  const abs = Math.abs(n);
  if (abs < 0.5) return null;
  const sign = n > 0 ? "+" : "−";
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}
