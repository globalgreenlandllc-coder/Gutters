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

export type Downspout = {
  id: string;
  x: number;
  y: number;
  heightFt: number;
};

export type Measurements = {
  eaveLF: number;
  rakeLF: number;
  outsideCorners: number;
  insideCorners: number;
  endCaps: number;
  downspoutCount: number;
  stories: 1 | 2;
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

export type EstimateConfig = {
  size: GutterSize;
  style: GutterStyle;
  material: GutterMaterial;
  color: string;
  downspoutSize: DownspoutSize;
};
