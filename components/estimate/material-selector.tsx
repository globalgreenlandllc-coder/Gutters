"use client";

import { cn } from "@/lib/utils";
import type { EstimateConfig, GutterMaterial, GutterSize, GutterStyle, DownspoutSize } from "@/lib/types";
import { COLOR_OPTIONS } from "@/lib/pricing";

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
  return (
    <div className="space-y-5">
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
                  "group flex items-center gap-2 rounded-full border px-2.5 py-1.5 transition",
                  selected
                    ? "border-accent-400/60 bg-accent-500/10"
                    : "border-white/10 bg-white/[0.02] hover:border-white/25",
                )}
              >
                <span
                  className="h-4 w-4 rounded-full border border-black/30"
                  style={{ background: c.hex }}
                />
                <span
                  className={cn(
                    "text-xs",
                    selected ? "text-accent-200" : "text-zinc-300",
                  )}
                >
                  {c.name}
                </span>
              </button>
            );
          })}
        </div>
      </Group>
    </div>
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
      <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
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
                ? "border-accent-400/60 bg-accent-500/10 text-accent-200"
                : "border-white/10 bg-white/[0.02] text-zinc-300 hover:border-white/25 hover:text-white",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
