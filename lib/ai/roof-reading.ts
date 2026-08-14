/**
 * roof-reading.ts — the canonical READING CONTRACT the vision model emits, one
 * targeted sheet-question at a time, that deterministic code then reconciles
 * (LAW 1). This is the enriched replacement for the flat `BlueprintAnalysis`:
 * an explicit `masses[]` model, per-face elevation readings, and gables carried
 * as parameters (span / pitch / projecting) rather than pre-drawn geometry.
 *
 * It bakes in the correction addendum:
 *  - `per_face` records front / rear / left / right INDEPENDENTLY. The rear is
 *    never derived from the front; `symmetry_assumed` is always false.
 *  - Each gable defaults to FLUSH (`projecting:false`, `projection_ft:0`) unless
 *    a side elevation or the roof plan positively confirms the projection —
 *    `readingToMassInputs` enforces that default in CODE, so a face-view read
 *    can't inflate the takeoff with side eaves that don't exist.
 *  - Unreadable faces are listed in `elevation_unreadable` rather than guessed.
 *
 * PURE: no server-only / DOM / React — imports only engine types + pure helpers,
 * so it runs in the browser bundle and under `node --test`.
 */

import type {
  Confidence,
  EaveCondition,
  Facing,
  Gable,
  MassInput,
  ProjectionSource,
  SupportedOn,
} from "../roof-engine";
import type { Pt } from "../roof-skeleton";

export type FaceName = "front" | "rear" | "left" | "right";

/** One gable as READ (not yet drawn). `projecting`/`projection_source` decide,
 *  per Correction 2, whether it gains guttered side eaves. */
export type GableReading = {
  id: string;
  face: FaceName;
  /** Facing direction in the mass's coordinate frame (front vs rear gables are
   *  the same gable with opposite `facing` — never copy one to the other). */
  facing: Facing;
  /** Where the base sits on the eave line (mass coordinate space). */
  base_center: Pt;
  span_ft: number;
  /** rise : 12. */
  pitch: number;
  /** Correction 2: false (flush) unless a side view / roof plan confirms it. */
  projecting: boolean;
  /** Projection depth in ft — only meaningful when `projecting` is true. */
  projection_ft: number;
  /** Which view confirmed the projection. "none" ⇒ flush. */
  projection_source: ProjectionSource;
  eave_condition: EaveCondition;
  supported_on?: SupportedOn;
  /** A gable's rakes must start on an eave edge; false ⇒ re-read (spec §1.4). */
  anchored_to_eave: boolean;
  confidence: Confidence;
};

/** One elevation face, read on its own (Corrections 1 & 3). */
export type FaceReading = {
  face: FaceName;
  /** False ⇒ this face was too low-res to classify; every projection needing
   *  depth from it must be flagged, not guessed (Correction 4). */
  readable: boolean;
  gable_count: number;
  /** The face's fascia/gutter line is a single continuous run except where a
   *  confirmed projection interrupts it. */
  continuous_eave: boolean;
  gables: GableReading[];
  /** Projection ids this face positively confirmed (its perpendicular reads). */
  projections_confirmed: string[];
  confidence: Confidence;
};

export type PerFace = {
  front: FaceReading;
  rear: FaceReading;
  left: FaceReading;
  right: FaceReading;
};

/** One roof mass/tier as read from the roof plan + elevations. */
export type MassReading = {
  name: string;
  outline_polygon: Pt[];
  overhang_ft?: number | null;
  tier_height_ft?: number | null;
  /** Stated schedule area (ft²) for the area gate, when a schedule/title-block
   *  gives one. Null ⇒ the gate reports `no_schedule`, never a false failure. */
  stated_area_ft2?: number | null;
  /** Perimeter edge indices (edge i = outline[i]→outline[i+1]) that are
   *  guttered eaves. Rakes/gable-ends are simply omitted. */
  eave_edge_indices: number[];
  gables: GableReading[];
};

/** The full reading. `symmetry_assumed` is typed as the literal `false` so a
 *  reading that ever sets it true fails to type-check (Correction 1). */
export type RoofReading = {
  scale: { units_per_ft: number | null; confidence: Confidence; source: string };
  masses: MassReading[];
  per_face: PerFace;
  symmetry_assumed: false;
  elevation_unreadable: FaceName[];
  review_flags: string[];
};

/**
 * Resolve a gable reading's projection deterministically (Correction 2): a gable
 * gains a positive projection ONLY when it is marked projecting AND a view
 * (side elevation or roof plan) confirmed it AND a positive depth was read.
 * Everything else collapses to flush (projection 0) — the safe default that
 * contributes zero gutter.
 */
export function resolveProjectionFt(g: GableReading): number {
  const confirmed = g.projecting && g.projection_source !== "none" && g.projection_ft > 0;
  return confirmed ? g.projection_ft : 0;
}

/** Map a read gable to an engine `Gable`, applying the flush default. */
export function readingToGable(g: GableReading): Gable {
  return {
    baseCenter: g.base_center,
    span: g.span_ft,
    pitch: g.pitch,
    projection: resolveProjectionFt(g),
    facing: g.facing,
    name: g.id,
    eaveCondition: g.eave_condition,
    supportedOn: g.supported_on,
    projectionSource: g.projection_source,
  };
}

/** Lower a full reading into engine mass inputs. The engine then assembles the
 *  geometry, runs the gates, and computes the takeoff. */
export function readingToMassInputs(reading: RoofReading): MassInput[] {
  return (reading.masses ?? []).map((m) => ({
    name: m.name,
    outline: m.outline_polygon,
    statedArea: m.stated_area_ft2 ?? null,
    eaveEdges: m.eave_edge_indices ?? [],
    gables: (m.gables ?? []).map(readingToGable),
    overhangFt: m.overhang_ft ?? undefined,
  }));
}
