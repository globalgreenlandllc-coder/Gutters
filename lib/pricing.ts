import type {
  DownspoutSize,
  EstimateConfig,
  GutterMaterial,
  GutterSize,
  GutterStyle,
  LineItem,
  Measurements,
} from "./types";

type GutterKey = `${GutterSize}-${GutterStyle}-${GutterMaterial}`;

export const GUTTER_UNIT_PRICES: Record<GutterKey, number> = {
  "5-k-style-aluminum": 8.5,
  "6-k-style-aluminum": 12,
  "7-k-style-aluminum": 16.5,
  "5-half-round-aluminum": 11,
  "6-half-round-aluminum": 14,
  "7-half-round-aluminum": 19,
  "5-k-style-steel": 11.5,
  "6-k-style-steel": 14.75,
  "7-k-style-steel": 19,
  "5-half-round-steel": 14,
  "6-half-round-steel": 17.5,
  "7-half-round-steel": 22,
  "5-k-style-copper": 28,
  "6-k-style-copper": 32,
  "7-k-style-copper": 39,
  "5-half-round-copper": 30,
  "6-half-round-copper": 36,
  "7-half-round-copper": 44,
};

export const DOWNSPOUT_UNIT_PRICES: Record<DownspoutSize, number> = {
  "2x3": 7.5,
  "3x4": 9,
  "round-3": 12,
  "round-4": 14.5,
};

export function gutterUnitPrice(cfg: EstimateConfig) {
  const key: GutterKey = `${cfg.size}-${cfg.style}-${cfg.material}`;
  return GUTTER_UNIT_PRICES[key] ?? 12;
}

export function downspoutUnitPrice(cfg: EstimateConfig) {
  return DOWNSPOUT_UNIT_PRICES[cfg.downspoutSize] ?? 9;
}

export function downspoutLengthFt(stories: 1 | 2 | 3) {
  if (stories === 3) return 30;
  if (stories === 2) return 20;
  return 10;
}

export const COLOR_OPTIONS = [
  { id: "white", name: "Classic White", hex: "#f4f4f5" },
  { id: "almond", name: "Almond", hex: "#ddd1bd" },
  { id: "musket", name: "Musket Brown", hex: "#5a3d2b" },
  { id: "graphite", name: "Graphite", hex: "#3a3d44" },
  { id: "black", name: "Onyx Black", hex: "#0c0e12" },
  { id: "copper", name: "Natural Copper", hex: "#b87333" },
];

export type LineItemPlan = {
  id: string;
  name: string;
  description?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxable: boolean;
};

export function buildLineItems(
  measurements: Measurements,
  config: EstimateConfig,
): LineItemPlan[] {
  const totalLF = Math.ceil(
    measurements.eaveLF * (1 + measurements.wasteFactorPct / 100),
  );
  const dsUnit = downspoutLengthFt(measurements.stories);
  const dsLF = measurements.downspoutCount * dsUnit;

  const gutter = gutterUnitPrice(config);
  const downspout = downspoutUnitPrice(config);

  return [
    {
      id: "gutter",
      name: `${config.size}" ${labelStyle(config.style)} Gutter — ${labelMaterial(
        config.material,
      )}`,
      description: `Includes ${measurements.wasteFactorPct}% waste factor`,
      quantity: totalLF,
      unit: "LF",
      unitPrice: gutter,
      taxable: true,
    },
    {
      id: "downspouts",
      name: `${labelDownspout(config.downspoutSize)} Downspouts`,
      description: `${measurements.downspoutCount} runs × ${dsUnit} ft (${
        measurements.stories
      }-story)`,
      quantity: dsLF,
      unit: "LF",
      unitPrice: downspout,
      taxable: true,
    },
    {
      id: "outside-corners",
      name: "Outside Mitered Corners",
      quantity: measurements.outsideCorners,
      unit: "ea",
      unitPrice: 22,
      taxable: true,
    },
    {
      id: "inside-corners",
      name: "Inside Mitered Corners",
      quantity: measurements.insideCorners,
      unit: "ea",
      unitPrice: 24,
      taxable: true,
    },
    {
      id: "end-caps",
      name: "End Caps",
      quantity: measurements.endCaps,
      unit: "ea",
      unitPrice: 6,
      taxable: true,
    },
    {
      id: "hangers",
      name: "Hidden Hangers",
      description: "1 hanger per 24 inches",
      quantity: Math.ceil(totalLF / 2),
      unit: "ea",
      unitPrice: 3.25,
      taxable: true,
    },
    {
      id: "elbows",
      name: "Downspout Elbows",
      quantity: measurements.downspoutCount * 2,
      unit: "ea",
      unitPrice: 4.5,
      taxable: true,
    },
    {
      id: "labor",
      name: "Installation Labor",
      description: "Removal of existing, install, sealants, cleanup",
      quantity: 1,
      unit: "lot",
      unitPrice: Math.round(totalLF * 4 + dsLF * 2 + 250),
      taxable: false,
    },
    ...accessoryLineItems(measurements, config, totalLF),
  ];
}

/**
 * Optional add-on line items derived from config.accessories. Empty
 * accessories yield an empty array so the base BOM stays clean.
 *
 * Pricing assumptions (industry rough numbers, tunable in admin
 * MaterialDefaults later):
 *   - Screen guard       $2.50/LF
 *   - Mesh guard         $4.00/LF
 *   - Micro-mesh guard   $7.50/LF  (premium tier)
 *   - Drip edge          $2.20/LF
 *   - Rain chain         $185 each (single chain replaces one downspout)
 *   - Ice/snow guards    $6.00/LF (running eaves only)
 *   - Heat tape          $14/LF eaves + $120 controller
 */
function accessoryLineItems(
  measurements: Measurements,
  config: EstimateConfig,
  totalLF: number,
): LineItem[] {
  const acc = config.accessories;
  if (!acc) return [];
  const out: LineItem[] = [];
  const eaveLF = measurements.eaveLF;

  if (acc.guard !== "none") {
    const unit =
      acc.guard === "screen" ? 2.5 : acc.guard === "mesh" ? 4 : 7.5;
    const guardLabel =
      acc.guard === "screen"
        ? "Screen leaf guards"
        : acc.guard === "mesh"
          ? "Mesh leaf guards"
          : "Micro-mesh leaf guards";
    out.push({
      id: "guards",
      name: guardLabel,
      description: "Snap-on, fits selected gutter profile",
      quantity: eaveLF,
      unit: "LF",
      unitPrice: unit,
      taxable: true,
    });
  }
  if (acc.dripEdge) {
    out.push({
      id: "drip-edge",
      name: "Aluminum drip edge",
      description: "Color-matched, sealed at fascia",
      quantity: eaveLF,
      unit: "LF",
      unitPrice: 2.2,
      taxable: true,
    });
  }
  if (acc.rainChain) {
    out.push({
      id: "rain-chain",
      name: "Decorative copper rain chain",
      description: "Replaces one downspout outlet",
      quantity: 1,
      unit: "ea",
      unitPrice: 185,
      taxable: true,
    });
  }
  if (acc.iceGuard) {
    out.push({
      id: "ice-guards",
      name: "Snow / ice guards",
      description: "Roof-edge ice dam protection",
      quantity: eaveLF,
      unit: "LF",
      unitPrice: 6,
      taxable: true,
    });
  }
  if (acc.heatTape) {
    out.push({
      id: "heat-tape",
      name: "Heat tape kit",
      description: "Self-regulating cable + thermostat controller",
      quantity: eaveLF,
      unit: "LF",
      unitPrice: 14,
      taxable: true,
    });
    out.push({
      id: "heat-tape-controller",
      name: "Heat tape controller",
      quantity: 1,
      unit: "ea",
      unitPrice: 120,
      taxable: true,
    });
  }
  return out;
}

function labelStyle(s: GutterStyle) {
  return s === "k-style" ? "K-Style" : "Half-Round";
}
function labelMaterial(m: GutterMaterial) {
  return m === "aluminum" ? "Aluminum" : m === "copper" ? "Copper" : "Steel";
}
function labelDownspout(d: DownspoutSize) {
  return {
    "2x3": '2"×3" Rectangular',
    "3x4": '3"×4" Rectangular',
    "round-3": '3" Round',
    "round-4": '4" Round',
  }[d];
}
