/**
 * score.ts — measures how close an engine run is to the admin's ground
 * truth. Pure math, node-testable, no server-only.
 *
 * Both sides are converted to FEET and normalized to their own anchor
 * (roof-perimeter bbox center when available, else the eave bbox center)
 * before comparing. That makes the score robust to the one thing replays
 * legitimately change: a newer engine may crop/fit the canvas differently,
 * shifting every canvas coordinate while the roof itself is identical.
 * North-up orientation never changes, so translation is the only nuisance
 * transform to remove.
 *
 * Eave agreement is LF-weighted coverage in both directions:
 *   precision — of the feet the engine drew, how many lie within TOL of a
 *               truth gutter run (excess/phantom gutter hurts this)
 *   recall    — of the feet the truth has, how many the engine covered
 *               (missed gutter hurts this)
 * scorePct blends their harmonic mean with a downspout match ratio.
 */

type Pt = { x: number; y: number };
type Line = { points: Pt[] };

export type ScoreSide = {
  eaves: Line[];
  downspouts: Pt[];
  /** Canvas px per foot for THIS side's coordinate space. */
  pxPerFt: number;
  /** Normalization anchor in the same canvas space (perimeter bbox center).
   *  Falls back to the eave bbox center when absent. */
  anchor?: Pt | null;
};

export type LabScore = {
  scorePct: number;
  eaveF1: number;
  eavePrecision: number;
  eaveRecall: number;
  engineEaveLF: number;
  truthEaveLF: number;
  /** |engine − truth| / truth, percent (0 when truth is 0). */
  lfErrorPct: number;
  downspouts: { engine: number; truth: number; matched: number };
  /** True when this run would have needed no correction. */
  clean: boolean;
  /** Set when the replayed engine produced no geometry at all. */
  engineReturnedNull?: boolean;
};

const DEFAULT_TOL_FT = 3;
const DEFAULT_DS_TOL_FT = 6;
const SAMPLE_STEP_FT = 1;
/** eaveF1 at/above this, with downspouts fully matched, counts as a run
 *  that would have needed no correction. */
const CLEAN_F1 = 0.97;

function bboxCenter(pts: Pt[]): Pt | null {
  if (pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** Convert a side to feet-space polylines, shifted by `anchor` (canvas px). */
function normalize(side: ScoreSide, anchor: Pt): { lines: Pt[][]; downspouts: Pt[] } {
  const s = side.pxPerFt > 0 ? 1 / side.pxPerFt : 0;
  const cvt = (p: Pt): Pt => ({ x: (p.x - anchor.x) * s, y: (p.y - anchor.y) * s });
  return {
    lines: side.eaves.map((l) => l.points.map(cvt)).filter((pts) => pts.length >= 2),
    downspouts: side.downspouts.map(cvt),
  };
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToLines(p: Pt, lines: Pt[][]): number {
  let best = Infinity;
  for (const pts of lines) {
    for (let i = 1; i < pts.length; i++) {
      best = Math.min(best, segDist(p, pts[i - 1], pts[i]));
      if (best === 0) return 0;
    }
  }
  return best;
}

function totalLF(lines: Pt[][]): number {
  let lf = 0;
  for (const pts of lines) {
    for (let i = 1; i < pts.length; i++) {
      lf += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
  }
  return lf;
}

/** Fraction of `subject`'s LF lying within tolFt of `reference`. */
function coveredFraction(subject: Pt[][], reference: Pt[][], tolFt: number): number {
  let total = 0;
  let covered = 0;
  for (const pts of subject) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(segLen / SAMPLE_STEP_FT));
      const stepLen = segLen / steps;
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        total += stepLen;
        if (distToLines(p, reference) <= tolFt) covered += stepLen;
      }
    }
  }
  return total > 0 ? covered / total : 0;
}

export function scoreAgainstTruth(
  engine: ScoreSide,
  truth: ScoreSide,
  opts?: { tolFt?: number; dsTolFt?: number },
): LabScore {
  // Alignment is not knowable a priori: usually both sides share one canvas
  // space (identity is right), but a replayed engine may have re-cropped
  // (translation), and bbox-center anchoring is itself skewed by phantom or
  // missing geometry. A WRONG alignment can only depress the score, so try
  // the plausible candidates and keep the best result.
  const candidates: [Pt, Pt][] = [[{ x: 0, y: 0 }, { x: 0, y: 0 }]];
  if (engine.anchor && truth.anchor) candidates.push([engine.anchor, truth.anchor]);
  const eBox = bboxCenter(engine.eaves.flatMap((l) => l.points));
  const tBox = bboxCenter(truth.eaves.flatMap((l) => l.points));
  if (eBox && tBox) candidates.push([eBox, tBox]);

  let best: LabScore | null = null;
  for (const [ea, ta] of candidates) {
    const s = scoreAligned(engine, truth, ea, ta, opts);
    if (!best || s.scorePct > best.scorePct) best = s;
  }
  return best!;
}

function scoreAligned(
  engine: ScoreSide,
  truth: ScoreSide,
  engineAnchor: Pt,
  truthAnchor: Pt,
  opts?: { tolFt?: number; dsTolFt?: number },
): LabScore {
  const tolFt = opts?.tolFt ?? DEFAULT_TOL_FT;
  const dsTolFt = opts?.dsTolFt ?? DEFAULT_DS_TOL_FT;

  const e = normalize(engine, engineAnchor);
  const t = normalize(truth, truthAnchor);
  const engineEaveLF = totalLF(e.lines);
  const truthEaveLF = totalLF(t.lines);

  let precision: number;
  let recall: number;
  if (engineEaveLF === 0 && truthEaveLF === 0) {
    precision = 1; recall = 1;
  } else if (engineEaveLF === 0 || truthEaveLF === 0) {
    precision = 0; recall = 0;
  } else {
    precision = coveredFraction(e.lines, t.lines, tolFt);
    recall = coveredFraction(t.lines, e.lines, tolFt);
  }
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // Greedy nearest-pair downspout matching within tolerance.
  const remaining = [...t.downspouts];
  let matched = 0;
  for (const d of e.downspouts) {
    let bestIdx = -1;
    let bestDist = dsTolFt;
    for (let i = 0; i < remaining.length; i++) {
      const dist = Math.hypot(d.x - remaining[i].x, d.y - remaining[i].y);
      if (dist <= bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx >= 0) { matched++; remaining.splice(bestIdx, 1); }
  }
  const dsDenom = Math.max(e.downspouts.length, t.downspouts.length);
  const dsScore = dsDenom === 0 ? 1 : matched / dsDenom;

  const scorePct = Math.round((0.85 * f1 + 0.15 * dsScore) * 100);
  const clean =
    f1 >= CLEAN_F1 &&
    matched === dsDenom;

  return {
    scorePct,
    eaveF1: Math.round(f1 * 1000) / 1000,
    eavePrecision: Math.round(precision * 1000) / 1000,
    eaveRecall: Math.round(recall * 1000) / 1000,
    engineEaveLF: Math.round(engineEaveLF * 10) / 10,
    truthEaveLF: Math.round(truthEaveLF * 10) / 10,
    lfErrorPct:
      truthEaveLF > 0
        ? Math.round((Math.abs(engineEaveLF - truthEaveLF) / truthEaveLF) * 1000) / 10
        : 0,
    downspouts: { engine: engine.downspouts.length, truth: truth.downspouts.length, matched },
    clean,
  };
}
