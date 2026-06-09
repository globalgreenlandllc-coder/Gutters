"use client";

import { Check, Droplet, Flame, Mountain, Shield, Waves } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  EstimateConfig,
  GutterAccessories,
  GutterMaterial,
  GutterSize,
  GutterStyle,
  DownspoutSize,
} from "@/lib/types";
import { COLOR_OPTIONS } from "@/lib/pricing";
import { GutterPreview } from "./gutter-preview";

const DEFAULT_ACCESSORIES: GutterAccessories = {
  guard: "none",
  dripEdge: false,
  rainChain: false,
  iceGuard: false,
  heatTape: false,
};

const GUARD_OPTIONS: { id: GutterAccessories["guard"]; label: string; sub: string }[] = [
  { id: "none", label: "None", sub: "Open gutter" },
  { id: "screen", label: "Screen", sub: "Coarse mesh · keeps out leaves" },
  { id: "mesh", label: "Mesh", sub: "Fine mesh · keeps out pine needles" },
  {
    id: "micro-mesh",
    label: "Micro-mesh",
    sub: "Premium · keeps out grit + shingle granules",
  },
];

const SIZES: { id: GutterSize; label: string }[] = [
  { id: "5", label: '5"' },
  { id: "6", label: '6"' },
  { id: "7", label: '7"' },
];

const STYLES: { id: GutterStyle; label: string }[] = [
  { id: "k-style", label: "K-Style" },
  { id: "half-round", label: "Half-Round" },
];

const MATERIALS: { id: GutterMaterial; label: string }[] = [
  { id: "aluminum", label: "Aluminum" },
  { id: "steel", label: "Steel" },
  { id: "copper", label: "Copper" },
];

const DOWNSPOUTS: { id: DownspoutSize; label: string }[] = [
  { id: "2x3", label: '2"×3"' },
  { id: "3x4", label: '3"×4"' },
  { id: "round-3", label: '3" round' },
  { id: "round-4", label: '4" round' },
];

export function MaterialSelector({
  config,
  onChange,
}: {
  config: EstimateConfig;
  onChange: (next: EstimateConfig) => void;
}) {
  const accessories = config.accessories ?? DEFAULT_ACCESSORIES;
  const setAcc = (patch: Partial<GutterAccessories>) =>
    onChange({ ...config, accessories: { ...accessories, ...patch } });

  return (
    <div className="space-y-5">
      <GutterPreview config={config} />

      <Group label="Size">
        <Pills
          options={SIZES}
          value={config.size}
          onChange={(v) => onChange({ ...config, size: v })}
        />
      </Group>
      <Group label="Profile">
        <Pills
          options={STYLES}
          value={config.style}
          onChange={(v) => onChange({ ...config, style: v })}
        />
      </Group>
      <Group label="Material">
        <Pills
          options={MATERIALS}
          value={config.material}
          onChange={(v) => onChange({ ...config, material: v })}
        />
      </Group>
      <Group label="Downspout">
        <Pills
          options={DOWNSPOUTS}
          value={config.downspoutSize}
          onChange={(v) => onChange({ ...config, downspoutSize: v })}
        />
      </Group>
      <Group label="Color">
        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map((c) => {
            const selected = config.color === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onChange({ ...config, color: c.id })}
                title={c.name}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-2.5 py-1.5 transition",
                  selected
                    ? "border-accent-500 bg-accent-50 text-accent-800"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300",
                )}
              >
                <span
                  className="h-4 w-4 rounded-full border border-zinc-300 shadow-inner"
                  style={{ background: c.hex }}
                />
                <span className="text-xs">{c.name}</span>
              </button>
            );
          })}
        </div>
      </Group>

      <Group label="Leaf protection">
        <div className="grid grid-cols-2 gap-1.5">
          {GUARD_OPTIONS.map((g) => {
            const selected = accessories.guard === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setAcc({ guard: g.id })}
                className={cn(
                  "group flex items-start gap-2 rounded-lg border p-2.5 text-left transition",
                  selected
                    ? "border-accent-500 bg-accent-50 ring-1 ring-accent-200"
                    : "border-zinc-200 bg-white hover:border-zinc-300",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
                    selected
                      ? "border-accent-600 bg-accent-600 text-white"
                      : "border-zinc-300 group-hover:border-zinc-400",
                  )}
                >
                  {selected && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="min-w-0">
                  <div className="text-xs font-medium text-zinc-900">{g.label}</div>
                  <div className="text-[10px] text-zinc-500">{g.sub}</div>
                </span>
              </button>
            );
          })}
        </div>
      </Group>

      <Group label="Accessories">
        <div className="grid grid-cols-1 gap-1.5">
          <AccessoryRow
            Icon={Mountain}
            label="Drip edge flashing"
            sub="Aluminum, sealed at fascia"
            checked={accessories.dripEdge}
            onChange={(v) => setAcc({ dripEdge: v })}
          />
          <AccessoryRow
            Icon={Droplet}
            label="Decorative rain chain"
            sub="Replaces one downspout with copper chain"
            checked={accessories.rainChain}
            onChange={(v) => setAcc({ rainChain: v })}
          />
          <AccessoryRow
            Icon={Shield}
            label="Snow / ice guards"
            sub="Roof-edge ice dam protection"
            checked={accessories.iceGuard}
            onChange={(v) => setAcc({ iceGuard: v })}
          />
          <AccessoryRow
            Icon={Flame}
            label="Heat tape kit"
            sub="Self-regulating cable + thermostat"
            checked={accessories.heatTape}
            onChange={(v) => setAcc({ heatTape: v })}
          />
        </div>
      </Group>
    </div>
  );
}

function AccessoryRow({
  Icon,
  label,
  sub,
  checked,
  onChange,
}: {
  Icon: typeof Waves;
  label: string;
  sub: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition",
        checked
          ? "border-accent-500 bg-accent-50 ring-1 ring-accent-200"
          : "border-zinc-200 bg-white hover:border-zinc-300",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset",
          checked
            ? "bg-accent-100 text-accent-700 ring-accent-200"
            : "bg-zinc-50 text-zinc-500 ring-zinc-200",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-900">{label}</div>
        <div className="text-[10px] text-zinc-500">{sub}</div>
      </span>
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border transition",
          checked
            ? "border-accent-600 bg-accent-600 text-white"
            : "border-zinc-300",
        )}
      >
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
    </button>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      {children}
    </div>
  );
}

function Pills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-sm transition",
              selected
                ? "border-accent-500 bg-accent-50 text-accent-800"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
