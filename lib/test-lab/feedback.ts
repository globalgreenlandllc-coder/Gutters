/**
 * feedback.ts — turns a LabDiff + the admin's click-tags into the
 * "here's my read on why the engine got this wrong" panel. Pure string
 * building; the tag ids double as the failure-category taxonomy the
 * scoreboard trends over time.
 */
import type { LabDiff } from "./diff";

export const LAB_TAGS = [
  { id: "shed", label: "Shed / detached structure" },
  { id: "screen_enclosure", label: "Screened enclosure / lanai" },
  { id: "vegetation", label: "Bushes / tree overhang" },
  { id: "neighbor", label: "Neighbor's roof" },
  { id: "imagery", label: "Shadow / bad imagery" },
  { id: "wrong_length", label: "Wrong length / offset" },
  { id: "missing_gutter", label: "Missed a real gutter" },
  { id: "other", label: "Other" },
] as const;

export type LabTagId = (typeof LAB_TAGS)[number]["id"];

export type LabTag = {
  /** Change key from LabDiff (e.g. "eave:solar-eave-3", "ds:ds-1"). */
  key: string;
  tag: LabTagId;
  note?: string;
};

export type LabFeedbackItem = {
  category: string;
  title: string;
  detail: string;
};

export type LabFeedback = {
  headline: string;
  items: LabFeedbackItem[];
};

const round = (n: number) => Math.round(n * 10) / 10;

/** Cause-specific explanations for DELETED geometry, keyed by tag. */
const DELETED_READS: Record<string, (lf: number) => LabFeedbackItem> = {
  shed: (lf) => ({
    category: "shed",
    title: "Gutter drawn on a detached structure",
    detail: `Now I get it — the engine wrapped ~${round(lf)} LF of gutter around a shed or detached garage. Google's building mask merged it with the home. Fix direction: a detached-mass veto (mask connectivity + height break between the masses).`,
  }),
  screen_enclosure: (lf) => ({
    category: "screen_enclosure",
    title: "Screened enclosure priced as roof",
    detail: `A lanai/pool cage got ~${round(lf)} LF of gutter. It slipped past the see-through veto — this labeled example is exactly what tightening that gate needs (mesh color/evidence thresholds).`,
  }),
  vegetation: (lf) => ({
    category: "vegetation",
    title: "Vegetation bled into the roof mask",
    detail: `~${round(lf)} LF followed bushes or tree canopy, not roof edge. The mask absorbed vegetation touching the eave line; a canopy check (height texture + color) at the drip edge is the fix.`,
  }),
  neighbor: (lf) => ({
    category: "neighbor",
    title: "Traced onto a neighboring roof",
    detail: `~${round(lf)} LF landed on the neighbor's structure. The layer window caught both buildings and the mask didn't separate them — a parcel/centroid distance veto would cut this.`,
  }),
  imagery: (lf) => ({
    category: "imagery",
    title: "Shadow or imagery artifact traced",
    detail: `~${round(lf)} LF followed a shadow/artifact rather than a real edge. Worth checking the imagery date and quality for this address in the run notes.`,
  }),
  other: (lf) => ({
    category: "other",
    title: "Removed geometry (untagged cause)",
    detail: `~${round(lf)} LF removed. No preset cause fit — the note (if any) is the signal here.`,
  }),
};

export function buildFeedback(diff: LabDiff, tags: LabTag[]): LabFeedback {
  const tagByKey = new Map(tags.map((t) => [t.key, t]));
  const items: LabFeedbackItem[] = [];

  const deleted = diff.changes.filter((c) => c.action === "deleted");
  const added = diff.changes.filter((c) => c.action === "added");
  const moved = diff.changes.filter((c) => c.action === "moved");
  const reclassified = diff.changes.filter((c) => c.action === "reclassified");

  // Group deleted geometry by tagged cause so 3 lanai deletions read as
  // one lesson, not three.
  const deletedByTag = new Map<string, number>();
  for (const c of deleted) {
    const tag = tagByKey.get(c.key)?.tag ?? "other";
    deletedByTag.set(tag, (deletedByTag.get(tag) ?? 0) + c.lengthFt);
  }
  for (const [tag, lf] of deletedByTag) {
    const read = DELETED_READS[tag] ?? DELETED_READS.other;
    const item = read(lf);
    const note = deleted
      .map((c) => tagByKey.get(c.key))
      .find((t) => t?.tag === tag && t.note)?.note;
    items.push(note ? { ...item, detail: `${item.detail} Admin note: "${note}"` } : item);
  }

  if (added.length > 0) {
    const lf = added.reduce((s, c) => s + c.lengthFt, 0);
    items.push({
      category: "missing_gutter",
      title: `Engine missed ${round(lf)} LF of real gutter`,
      detail: `You drew ${added.length} run${added.length === 1 ? "" : "s"} the engine never saw — a recall gap. Common causes: an inner eave between wings, a porch/garage projection, or a tier step the drip-edge trace skipped.`,
    });
  }

  if (moved.length > 0) {
    const totalShift = moved.reduce((s, c) => s + (c.maxShiftFt ?? 0), 0);
    const netLf = moved.reduce((s, c) => s + (c.lfDeltaFt ?? 0), 0);
    items.push({
      category: "wrong_length",
      title: `${moved.length} run${moved.length === 1 ? "" : "s"} nudged into place`,
      detail: `Average correction ${round(totalShift / moved.length)} ft, net length change ${netLf >= 0 ? "+" : ""}${round(netLf)} LF. If this direction repeats across runs it becomes an automatic calibration (overhang/snap bias), no code change needed.`,
    });
  }

  if (reclassified.length > 0) {
    items.push({
      category: "reclassified",
      title: `${reclassified.length} edge${reclassified.length === 1 ? "" : "s"} flipped eave⇄gable`,
      detail: `The geometry was right but the gutter/no-gutter call was wrong — that's the edge classifier (slope direction at the wall), not the tracer.`,
    });
  }

  const dsAdded = diff.downspoutChanges.filter((c) => c.action === "added").length;
  const dsDeleted = diff.downspoutChanges.filter((c) => c.action === "deleted").length;
  const dsMoved = diff.downspoutChanges.filter((c) => c.action === "moved").length;
  if (dsAdded + dsDeleted + dsMoved > 0) {
    items.push({
      category: "downspouts",
      title: "Downspout placement corrected",
      detail: `${dsAdded} added, ${dsDeleted} removed, ${dsMoved} moved. Placement spacing/corner preferences are calibratable once a pattern shows across runs.`,
    });
  }

  if (Math.abs(diff.lfDeltaPct) >= 3 && diff.eaveLFBefore > 0) {
    items.push({
      category: "lf_bias",
      title: `Net ${diff.lfDeltaPct > 0 ? "under" : "over"}-draw of ${Math.abs(diff.lfDeltaPct)}%`,
      detail: `Engine ${round(diff.eaveLFBefore)} LF → corrected ${round(diff.eaveLFAfter)} LF. A consistent sign here across ~3+ runs feeds the learned length calibration automatically.`,
    });
  }

  const totalChanges = diff.changes.length + diff.downspoutChanges.length;
  const headline = diff.isClean
    ? "Clean pass — the engine needed no correction on this roof. Saved as ground truth."
    : `${totalChanges} correction${totalChanges === 1 ? "" : "s"} captured. Here's my read:`;

  return { headline, items };
}
