export type GutterStyle = "k-style" | "half-round";
export type GutterSize = "5" | "6" | "7";
export type GutterMaterial = "aluminum" | "copper" | "steel";

export type DownspoutSize = "2x3" | "3x4" | "round-3" | "round-4";

export type LineEdgeKind = "eave" | "rake";

export type EditableLine = {
  id: string;
  kind: LineEdgeKind;
  points: { x: number; y: number }[];
};

export type RoofStructureLineKind = "ridge" | "valley";

export type RoofStructureLine = {
  id: string;
  kind: RoofStructureLineKind;
  /** Canvas-space (900×580 viewBox) endpoints. */
  points: { x: number; y: number }[];
  label?: string;
};

/**
 * Visual roof annotation — the white perimeter outline plus the dashed
 * ridge/valley lines that show where the roof's planes peak and where
 * they drain together. NOT used for measurements (eaves drive LF math)
 * — purely a recreational aid that helps the contractor read the roof.
 */
export type RoofStructure = {
  /** Closed perimeter polygon in canvas space. */
  perimeter: { x: number; y: number }[];
  ridges: RoofStructureLine[];
  valleys: RoofStructureLine[];
  /** 0–1, surfaces an "approximation only" warning when low. */
  confidence: number;
};

export type Downspout = {
  id: string;
  x: number;
  y: number;
  heightFt: number;
};

export type Stories = 1 | 2 | 3;

export const STORY_HEIGHT_FT: Record<Stories, number> = {
  1: 10,
  2: 20,
  3: 30,
};

export function storiesFromHeightFt(heightFt: number): Stories {
  if (heightFt <= 14) return 1;
  if (heightFt <= 24) return 2;
  return 3;
}

export type Measurements = {
  eaveLF: number;
  rakeLF: number;
  outsideCorners: number;
  insideCorners: number;
  endCaps: number;
  downspoutCount: number;
  stories: Stories;
  wasteFactorPct: number;
};

export type LineItem = {
  id: string;
  name: string;
  description?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxable: boolean;
};

/**
 * Optional add-on products / upgrades the contractor can tack on to
 * a base gutter system. Drive both the visual preview (the preview
 * component renders mesh on top of the gutter when guard.kind isn't
 * "none") and the line items (each enabled accessory adds a row to
 * buildLineItems).
 */
export type GutterAccessories = {
  /** Top-of-gutter leaf protection. */
  guard: "none" | "mesh" | "micro-mesh" | "screen";
  /** Aluminum drip-edge flashing — common upsell on new installs. */
  dripEdge: boolean;
  /** Decorative copper rain chain in place of a downspout (kept as
   *  separate flag; doesn't replace a downspout count, just adds it). */
  rainChain: boolean;
  /** Snow / ice guards along eaves in cold climates. */
  iceGuard: boolean;
  /** Heat tape kit to prevent ice damming. */
  heatTape: boolean;
};

export type EstimateConfig = {
  size: GutterSize;
  style: GutterStyle;
  material: GutterMaterial;
  color: string;
  downspoutSize: DownspoutSize;
  accessories?: GutterAccessories;
};
