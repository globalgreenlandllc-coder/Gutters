/**
 * diff.ts — classifies what the admin changed between the engine's gutter
 * takeoff and their corrected version. Pure math over canvas-space
 * geometry: no DB, no AI, no server-only — node-testable and safe to run
 * client-side for the live "changes" panel in the admin lab.
 *
 * Matching is by line id: the editing canvas preserves ids on move/reshape
 * and mints fresh ids for drawn lines, so id identity IS edit identity.
 * A line whose id appears on both sides but under a different kind
 * (eave⇄rake reclassify) is its own category — that edit means "the roof
 * shape was right but the gutter/no-gutter call was wrong".
 */
import type { Downspout, EditableLine } from "../types";

export type LabGeometry = {
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
};

export type LabLineChange = {
  /** Stable key tags attach to, e.g. "eave:solar-eave-3". */
  key: string;
  geo: "eave" | "rake";
  action: "deleted" | "added" | "moved" | "reclassified";
  id: string;
  /** LF of the segment (before-side for deleted/moved, after-side for added). */
  lengthFt: number;
  /** moved: LF(after) − LF(before). */
  lfDeltaFt?: number;
  /** moved: largest endpoint displacement, in feet. */
  maxShiftFt?: number;
  /** Midpoint in canvas coords — where the change lives on the photo. */
  at: { x: number; y: number };
};

export type LabDownspoutChange = {
  key: string;
  action: "deleted" | "added" | "moved";
  id: string;
  at: { x: number; y: number };
  shiftFt?: number;
};

export type LabDiff = {
  eaveLFBefore: number;
  eaveLFAfter: number;
  lfDeltaFt: number;
  /** Signed, relative to before (0 when before is 0). */
  lfDeltaPct: number;
  changes: LabLineChange[];
  downspoutChanges: LabDownspoutChange[];
  downspoutsBefore: number;
  downspoutsAfter: number;
  unchangedCount: number;
  /** True when nothing at all changed — an approve-as-is pass. */
  isClean: boolean;
};

/** Below this endpoint displacement (px) a line counts as untouched —
 *  absorbs float jitter from canvas round-trips. */
const SAME_EPS_PX = 0.75;

function polyLenPx(points: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

function midpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  // Walk to half the polyline length so the label lands ON the line.
  const half = polyLenPx(points) / 2;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (acc + seg >= half && seg > 0) {
      const t = (half - acc) / seg;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    acc += seg;
  }
  return points[Math.floor(points.length / 2)];
}

/** Max distance between corresponding endpoints; Infinity when the vertex
 *  counts differ (a reshape that added/removed vertices is a real move). */
function endpointShiftPx(a: EditableLine, b: EditableLine): number {
  if (a.points.length !== b.points.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.points.length; i++) {
    max = Math.max(
      max,
      Math.hypot(a.points[i].x - b.points[i].x, a.points[i].y - b.points[i].y),
    );
  }
  return max;
}

export function computeLabDiff(
  before: LabGeometry,
  after: LabGeometry,
  pxPerFt: number,
): LabDiff {
  const toFt = (px: number) => (pxPerFt > 0 ? px / pxPerFt : 0);
  const lineLF = (l: EditableLine) => toFt(polyLenPx(l.points));

  // One pool per side, keyed by id, remembering which list it lived in.
  type Entry = { line: EditableLine; geo: "eave" | "rake" };
  const pool = (g: LabGeometry): Map<string, Entry> => {
    const m = new Map<string, Entry>();
    for (const l of g.eaves) m.set(l.id, { line: l, geo: "eave" });
    for (const l of g.rakes) if (!m.has(l.id)) m.set(l.id, { line: l, geo: "rake" });
    return m;
  };
  const beforePool = pool(before);
  const afterPool = pool(after);

  const changes: LabLineChange[] = [];
  let unchangedCount = 0;

  for (const [id, b] of beforePool) {
    const a = afterPool.get(id);
    if (!a) {
      changes.push({
        key: `${b.geo}:${id}`,
        geo: b.geo,
        action: "deleted",
        id,
        lengthFt: lineLF(b.line),
        at: midpoint(b.line.points),
      });
      continue;
    }
    const shift = endpointShiftPx(b.line, a.line);
    if (a.geo !== b.geo) {
      changes.push({
        key: `${b.geo}:${id}`,
        geo: b.geo,
        action: "reclassified",
        id,
        lengthFt: lineLF(b.line),
        at: midpoint(a.line.points),
      });
    } else if (shift > SAME_EPS_PX) {
      changes.push({
        key: `${b.geo}:${id}`,
        geo: b.geo,
        action: "moved",
        id,
        lengthFt: lineLF(b.line),
        lfDeltaFt: lineLF(a.line) - lineLF(b.line),
        maxShiftFt: Number.isFinite(shift) ? toFt(shift) : undefined,
        at: midpoint(a.line.points),
      });
    } else {
      unchangedCount++;
    }
  }
  for (const [id, a] of afterPool) {
    if (!beforePool.has(id)) {
      changes.push({
        key: `${a.geo}:${id}`,
        geo: a.geo,
        action: "added",
        id,
        lengthFt: lineLF(a.line),
        at: midpoint(a.line.points),
      });
    }
  }

  const downspoutChanges: LabDownspoutChange[] = [];
  const dsBefore = new Map(before.downspouts.map((d) => [d.id, d]));
  const dsAfter = new Map(after.downspouts.map((d) => [d.id, d]));
  for (const [id, b] of dsBefore) {
    const a = dsAfter.get(id);
    if (!a) {
      downspoutChanges.push({ key: `ds:${id}`, action: "deleted", id, at: { x: b.x, y: b.y } });
    } else {
      const shift = Math.hypot(a.x - b.x, a.y - b.y);
      if (shift > SAME_EPS_PX) {
        downspoutChanges.push({
          key: `ds:${id}`,
          action: "moved",
          id,
          at: { x: a.x, y: a.y },
          shiftFt: toFt(shift),
        });
      } else {
        unchangedCount++;
      }
    }
  }
  for (const [id, a] of dsAfter) {
    if (!dsBefore.has(id)) {
      downspoutChanges.push({ key: `ds:${id}`, action: "added", id, at: { x: a.x, y: a.y } });
    }
  }

  const eaveLFBefore = before.eaves.reduce((s, l) => s + lineLF(l), 0);
  const eaveLFAfter = after.eaves.reduce((s, l) => s + lineLF(l), 0);
  const lfDeltaFt = eaveLFAfter - eaveLFBefore;

  return {
    eaveLFBefore: Math.round(eaveLFBefore * 10) / 10,
    eaveLFAfter: Math.round(eaveLFAfter * 10) / 10,
    lfDeltaFt: Math.round(lfDeltaFt * 10) / 10,
    lfDeltaPct: eaveLFBefore > 0 ? Math.round((lfDeltaFt / eaveLFBefore) * 1000) / 10 : 0,
    changes,
    downspoutChanges,
    downspoutsBefore: before.downspouts.length,
    downspoutsAfter: after.downspouts.length,
    unchangedCount,
    isClean: changes.length === 0 && downspoutChanges.length === 0,
  };
}
