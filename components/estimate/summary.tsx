"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileText, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import type { LineItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Adjustments = {
  markupPct: number;
  discountPct: number;
  taxPct: number;
};

export function Summary({
  items,
  adjustments,
  onAdjust,
}: {
  items: LineItem[];
  adjustments: Adjustments;
  onAdjust: (a: Adjustments) => void;
}) {
  const router = useRouter();
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const markup = subtotal * (adjustments.markupPct / 100);
  const afterMarkup = subtotal + markup;
  const discount = afterMarkup * (adjustments.discountPct / 100);
  const taxableBase = items
    .filter((i) => i.taxable)
    .reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const taxableAfterAdj =
    taxableBase *
    (1 + adjustments.markupPct / 100) *
    (1 - adjustments.discountPct / 100);
  const tax = taxableAfterAdj * (adjustments.taxPct / 100);
  const total = afterMarkup - discount + tax;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Adj
          label="Markup"
          suffix="%"
          value={adjustments.markupPct}
          onChange={(v) => onAdjust({ ...adjustments, markupPct: v })}
        />
        <Adj
          label="Discount"
          suffix="%"
          value={adjustments.discountPct}
          onChange={(v) => onAdjust({ ...adjustments, discountPct: v })}
        />
        <Adj
          label="Tax"
          suffix="%"
          value={adjustments.taxPct}
          onChange={(v) => onAdjust({ ...adjustments, taxPct: v })}
        />
      </div>

      <div className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-4">
        <Row label="Subtotal" value={subtotal} muted />
        <Row label={`Markup (${adjustments.markupPct}%)`} value={markup} muted />
        {adjustments.discountPct > 0 && (
          <Row
            label={`Discount (${adjustments.discountPct}%)`}
            value={-discount}
            muted
            tone="discount"
          />
        )}
        <Row label={`Tax (${adjustments.taxPct}%)`} value={tax} muted />
        <div className="my-3 h-px w-full bg-zinc-200" />
        <motion.div
          key={Math.round(total)}
          initial={{ opacity: 0.4, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-baseline justify-between"
        >
          <span className="text-xs uppercase tracking-wider text-zinc-500">
            Client total
          </span>
          <span className="font-display text-3xl font-semibold tabular-nums text-zinc-900">
            {formatCurrency(total)}
          </span>
        </motion.div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" onClick={() => router.push("/proposal")}>
          <Send className="h-4 w-4" />
          Send to client
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          onClick={() => router.push("/proposal")}
        >
          <FileText className="h-4 w-4" />
          Preview proposal
        </Button>
      </div>

      <ul className="space-y-1.5 text-xs text-zinc-500">
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-accent-600" />
          Auto-attaches signed warranty + T&Cs
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-accent-600" />
          Stripe Connect deposit + final invoice
        </li>
        <li className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-accent-600" />
          AI-drafted scope of work included
        </li>
      </ul>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: number;
  muted?: boolean;
  tone?: "discount";
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className={muted ? "text-zinc-500" : "text-zinc-700"}>{label}</span>
      <span
        className={cn(
          "tabular-nums",
          tone === "discount" ? "text-accent-700" : "text-zinc-900",
        )}
      >
        {formatCurrency(value)}
      </span>
    </div>
  );
}

function Adj({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 bg-white p-2.5 transition focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/15">
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          step={0.5}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-transparent text-base font-semibold tabular-nums text-zinc-900 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-sm text-zinc-400">{suffix}</span>
      </div>
    </label>
  );
}
