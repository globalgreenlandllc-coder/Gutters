"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Layers, Receipt, Wallet } from "lucide-react";
import type { EstimateConfig, LineItem, Measurements } from "@/lib/types";
import { buildLineItems } from "@/lib/pricing";
import type { EstimateHandoff } from "@/lib/estimate-handoff";
import { MaterialSelector } from "./material-selector";
import { PricingTable } from "./pricing-table";
import { Summary, type Adjustments } from "./summary";
import { cn } from "@/lib/utils";

type Tab = "materials" | "pricing" | "summary";

const TABS: { id: Tab; label: string; icon: typeof Layers }[] = [
  { id: "materials", label: "Materials", icon: Layers },
  { id: "pricing", label: "Pricing", icon: Receipt },
  { id: "summary", label: "Summary", icon: Wallet },
];

export function PricingPanel({
  measurements,
  handoff,
}: {
  measurements: Measurements;
  /** Threaded through to Summary so its "Send to client" button can
   *  hand the live takeoff (address + measurements + eaves + image)
   *  off to /proposal. */
  handoff?: Omit<EstimateHandoff, "capturedAt">;
}) {
  const [tab, setTab] = useState<Tab>("materials");
  const [config, setConfig] = useState<EstimateConfig>({
    size: "6",
    style: "k-style",
    material: "aluminum",
    color: "white",
    downspoutSize: "3x4",
  });

  const auto = useMemo(
    () => buildLineItems(measurements, config),
    [measurements, config],
  );
  const [items, setItems] = useState<LineItem[]>(auto);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setItems((prev) => {
      const autoIds = new Set(auto.map((i) => i.id));
      const custom = prev.filter((i) => !autoIds.has(i.id));
      return [...auto, ...custom];
    });
  }, [auto]);

  const [adjustments, setAdjustments] = useState<Adjustments>({
    markupPct: 15,
    discountPct: 0,
    taxPct: 8.25,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200/70 px-4 pb-4 pt-4">
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-accent-600">
          Estimate builder
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          AI scope auto-applies. Override anything below.
        </p>
        <div className="mt-3 flex rounded-lg border border-zinc-200 bg-white p-0.5">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition",
                  active
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-900",
                )}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            {tab === "materials" && (
              <MaterialSelector config={config} onChange={setConfig} />
            )}
            {tab === "pricing" && (
              <PricingTable items={items} onChange={setItems} />
            )}
            {tab === "summary" && (
              <Summary
                items={items}
                adjustments={adjustments}
                onAdjust={setAdjustments}
                handoff={handoff}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
