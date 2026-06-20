import type { EditableLine } from "@/lib/types";

/**
 * How much to trust the auto-traced satellite gutters. Drives the
 * "bad pic — draw it yourself" banner on the results screen so a blurry
 * tile or a SAM mask that locked onto the lawn never silently becomes a
 * priced estimate.
 *
 *   ok        → trace is trustworthy, no banner
 *   low       → trace is suspect; warn + offer the drawing tool, keep lines
 *   unusable  → trace is junk (mock geometry, lines off the roof, length
 *               that can't be this roof); tell them to draw it themselves
 */
export type TraceQuality = {
  status: "ok" | "low" | "unusable";
  /** 0–1; higher = more trustworthy. */
  confidence: number;
  /** Plain-English reasons, shown in the banner. Empty when status is ok. */
  reasons: string[];
};

/** Axis-aligned roof extent in canvas (900×580) space — the union of the
 *  Google Solar roof-segment bounding boxes, already padded for overhang. */
export type FootprintBboxCanvas = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const MIN_USABLE_LF = 15;

/**
 * Assess a satellite trace from signals the pipeline already has at
 * assembly time — no extra API call. Deliberately HIGH PRECISION: we'd
 * rather pass a mediocre-but-real trace than wrongly tell a contractor a
 * good estimate is junk. Only strong, corroborated red flags push to
 * "unusable".
 */
export function assessSatelliteTrace(args: {
  source: "ai" | "mock" | "partial";
  eaves: EditableLine[];
  totalEaveLF: number;
  /** Σ Google Solar roof-segment area in ft². null = no Solar coverage,
   *  so we can't cross-check the trace against the real building. */
  footprintAreaFt2: number | null;
  /** Solar footprint extent in canvas space. null = no Solar coverage. */
  footprintBboxCanvas: FootprintBboxCanvas | null;
}): TraceQuality {
  // 1. No real trace at all — the pipeline fell through to mock geometry.
  if (args.source === "mock") {
    return {
      status: "unusable",
      confidence: 0,
      reasons: ["Couldn't load a clear satellite image for this address."],
    };
  }

  const eavePts = args.eaves
    .flatMap((e) => e.points)
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  // 2. Degenerate trace: no geometry or a length too small to be a roof.
  if (eavePts.length < 2 || !(args.totalEaveLF >= MIN_USABLE_LF)) {
    return {
      status: "unusable",
      confidence: 0,
      reasons: ["Couldn't trace a usable gutter outline from this image."],
    };
  }

  const reasons: string[] = [];
  let score = 1; // start trusting, subtract per red flag

  // 3. Lines off the roof — the "random spots outside the building" case.
  //    Only checkable when Solar gave us a footprint to compare against.
  if (args.footprintBboxCanvas) {
    const b = args.footprintBboxCanvas;
    const inside = eavePts.filter(
      (p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY,
    ).length;
    const containment = inside / eavePts.length;
    if (containment < 0.6) {
      reasons.push(
        `${Math.round((1 - containment) * 100)}% of the traced lines landed off the building.`,
      );
      score -= 0.6;
    } else if (containment < 0.85) {
      reasons.push("Some traced lines drifted off the building footprint.");
      score -= 0.25;
    }
  }

  // 4. Traced length that can't be this roof (mis-trace inflates or
  //    collapses LF). Perimeter ≈ k·√area; normal roofs land k ≈ 2.5–9.
  if (args.footprintAreaFt2 && args.footprintAreaFt2 > 0) {
    const ratio = args.totalEaveLF / Math.sqrt(args.footprintAreaFt2);
    if (ratio > 12 || ratio < 1.5) {
      reasons.push(
        `Traced length (${Math.round(args.totalEaveLF)} LF) doesn't fit a roof this size.`,
      );
      score -= 0.5;
    } else if (ratio > 9 || ratio < 2.2) {
      reasons.push("Traced length is borderline for this roof size.");
      score -= 0.2;
    }
  } else {
    // No Solar footprint → we couldn't verify the trace against anything.
    reasons.push("No building data available to verify the trace.");
    score -= 0.2;
  }

  // 5. The AI pipeline only partially completed.
  if (args.source === "partial") {
    reasons.push("The AI takeoff only partially completed.");
    score -= 0.2;
  }

  const confidence = Math.max(0, Math.min(1, score));
  const status: TraceQuality["status"] =
    confidence < 0.45 ? "unusable" : confidence < 0.8 ? "low" : "ok";

  return { status, confidence, reasons: status === "ok" ? [] : reasons };
}
