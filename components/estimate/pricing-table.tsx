"use client";

import { Plus, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { LineItem } from "@/lib/types";
import { formatCurrency, cn } from "@/lib/utils";

export function PricingTable({
  items,
  onChange,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
}) {
  function update(id: string, patch: Partial<LineItem>) {
    onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }
  function remove(id: string) {
    onChange(items.filter((i) => i.id !== id));
  }
  function addRow() {
    onChange([
      ...items,
      {
        id: `custom-${Date.now()}`,
        name: "Custom line item",
        quantity: 1,
        unit: "ea",
        unitPrice: 0,
        taxable: true,
      },
    ]);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02]">
      <div className="hidden grid-cols-[minmax(0,1fr)_84px_60px_110px_110px_36px] gap-2 border-b border-white/10 px-3 py-2 text-[11px] uppercase tracking-wider text-zinc-500 sm:grid">
        <div>Item</div>
        <div className="text-right">Qty</div>
        <div className="text-center">Unit</div>
        <div className="text-right">Unit price</div>
        <div className="text-right">Total</div>
        <div />
      </div>

      <ul>
        <AnimatePresence initial={false}>
          {items.map((item) => {
            const total = item.quantity * item.unitPrice;
            return (
              <motion.li
                key={item.id}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="border-b border-white/[0.06] last:border-0"
              >
                <div className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_84px_60px_110px_110px_36px] sm:items-center">
                  <div className="min-w-0">
                    <input
                      value={item.name}
                      onChange={(e) => update(item.id, { name: e.target.value })}
                      className="w-full bg-transparent text-sm font-medium text-zinc-100 outline-none focus:text-white"
                    />
                    {item.description && (
                      <div className="mt-0.5 truncate text-xs text-zinc-500">
                        {item.description}
                      </div>
                    )}
                  </div>

                  <NumInput
                    value={item.quantity}
                    onChange={(v) => update(item.id, { quantity: v })}
                    align="right"
                    decimals={item.unit === "lot" ? 2 : 0}
                  />

                  <input
                    value={item.unit}
                    onChange={(e) => update(item.id, { unit: e.target.value })}
                    className="h-8 w-full rounded-md border border-white/10 bg-white/[0.02] px-2 text-center text-xs text-zinc-300 outline-none focus:border-accent-400/40"
                  />

                  <NumInput
                    value={item.unitPrice}
                    onChange={(v) => update(item.id, { unitPrice: v })}
                    prefix="$"
                    align="right"
                    decimals={2}
                  />

                  <div className="text-right text-sm font-semibold tabular-nums text-zinc-100">
                    {formatCurrency(total)}
                  </div>

                  <button
                    onClick={() => remove(item.id)}
                    className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-rose-500/15 hover:text-rose-300"
                    aria-label="Remove line item"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      <button
        onClick={addRow}
        className="flex w-full items-center justify-center gap-2 border-t border-dashed border-white/10 px-3 py-2.5 text-xs text-zinc-400 transition hover:bg-white/[0.03] hover:text-accent-300"
      >
        <Plus className="h-3.5 w-3.5" />
        Add line item
      </button>
    </div>
  );
}

function NumInput({
  value,
  onChange,
  prefix,
  align = "left",
  decimals = 0,
}: {
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  align?: "left" | "right";
  decimals?: number;
}) {
  return (
    <div
      className={cn(
        "flex h-8 items-center rounded-md border border-white/10 bg-white/[0.02] px-2 text-sm text-zinc-100 transition focus-within:border-accent-400/40",
        align === "right" && "justify-end",
      )}
    >
      {prefix && <span className="mr-0.5 text-zinc-500">{prefix}</span>}
      <input
        type="number"
        inputMode="decimal"
        step={decimals > 0 ? 0.01 : 1}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={cn(
          "w-full bg-transparent tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          align === "right" && "text-right",
        )}
      />
    </div>
  );
}
