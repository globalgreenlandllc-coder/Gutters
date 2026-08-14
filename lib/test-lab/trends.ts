/**
 * trends.ts — pure aggregation for the accuracy lab's two trend views:
 *
 *  · score history → daily accuracy points (the "watch it go up" line)
 *  · failure categories → recent vs prior correction rates per cause
 *    (the "lanai over-traces: 6 → 0" table; proves fixes GENERALIZE,
 *    not just that replays of known roofs pass)
 *
 * No DB, no server-only — node-testable, callable client-side.
 */
import type { LabTag } from "./feedback";

/* ------------------------------------------------------------------ */
/* Score trend                                                         */
/* ------------------------------------------------------------------ */

export type ScorePoint = {
  scorePct: number;
  clean: boolean;
  engineVersion: string | null;
  createdAt: string; // ISO
};

export type DailyTrendPoint = {
  day: string; // YYYY-MM-DD
  avgScorePct: number;
  cleanRate: number; // 0..1
  n: number;
  /** Engine versions that scored that day (usually one). */
  versions: string[];
};

export function dailyScoreTrend(points: ScorePoint[]): DailyTrendPoint[] {
  const byDay = new Map<string, ScorePoint[]>();
  for (const p of points) {
    const day = p.createdAt.slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(p);
    else byDay.set(day, [p]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, list]) => ({
      day,
      avgScorePct: Math.round(list.reduce((s, p) => s + p.scorePct, 0) / list.length),
      cleanRate: Math.round((list.filter((p) => p.clean).length / list.length) * 100) / 100,
      n: list.length,
      versions: [...new Set(list.map((p) => p.engineVersion).filter((v): v is string => !!v))],
    }));
}

/* ------------------------------------------------------------------ */
/* Failure-category trend                                              */
/* ------------------------------------------------------------------ */

/** The diff subset the trend needs (matches LabDiff's stored shape). */
export type TrendRunInput = {
  createdAt: string; // ISO
  tags: LabTag[];
  diff: {
    changes?: { key: string; action: string; lengthFt?: number }[];
    downspoutChanges?: { key: string; action: string }[];
  } | null;
};

export type CategoryTrendRow = {
  category: string;
  /** Corrections of this category in the recent window / runs in it. */
  recentCount: number;
  recentRuns: number;
  priorCount: number;
  priorRuns: number;
  /** Per-run rates, rounded to 2 decimals. */
  recentRate: number;
  priorRate: number;
  trend: "improving" | "worsening" | "flat" | "new";
  lfRecent: number;
  lfPrior: number;
};

/** A change's category: the admin's tag when present, else implied by the
 *  edit type. Keeps untagged data useful instead of invisible. */
function categoryOf(
  change: { key: string; action: string },
  tagByKey: Map<string, string>,
): string {
  const tagged = tagByKey.get(change.key);
  if (tagged && tagged !== "other") return tagged;
  switch (change.action) {
    case "added":
      return "missing_gutter";
    case "moved":
      return "wrong_length";
    case "reclassified":
      return "reclassified";
    default:
      return tagged ?? "untagged";
  }
}

/**
 * Split finalized runs into a recent window (last `windowSize`, default 10)
 * vs everything before it, and compare per-run correction rates by category.
 */
export function categoryTrends(
  runs: TrendRunInput[],
  windowSize = 10,
): CategoryTrendRow[] {
  const sorted = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const recent = sorted.slice(-windowSize);
  const prior = sorted.slice(0, Math.max(0, sorted.length - windowSize));

  type Acc = { count: number; lf: number };
  const collect = (subset: TrendRunInput[]): Map<string, Acc> => {
    const m = new Map<string, Acc>();
    for (const run of subset) {
      const tagByKey = new Map(run.tags.map((t) => [t.key, t.tag as string]));
      const bump = (cat: string, lf: number) => {
        const acc = m.get(cat) ?? { count: 0, lf: 0 };
        acc.count += 1;
        acc.lf += lf;
        m.set(cat, acc);
      };
      for (const c of run.diff?.changes ?? []) {
        bump(categoryOf(c, tagByKey), c.lengthFt ?? 0);
      }
      for (const c of run.diff?.downspoutChanges ?? []) {
        bump(tagByKey.get(c.key) ?? "downspouts", 0);
      }
    }
    return m;
  };

  const recentAcc = collect(recent);
  const priorAcc = collect(prior);
  const categories = new Set([...recentAcc.keys(), ...priorAcc.keys()]);

  const rows: CategoryTrendRow[] = [];
  for (const category of categories) {
    const r = recentAcc.get(category) ?? { count: 0, lf: 0 };
    const p = priorAcc.get(category) ?? { count: 0, lf: 0 };
    const recentRate = recent.length > 0 ? r.count / recent.length : 0;
    const priorRate = prior.length > 0 ? p.count / prior.length : 0;
    let trend: CategoryTrendRow["trend"];
    if (prior.length === 0) trend = "new";
    else if (recentRate < priorRate - 0.05) trend = "improving";
    else if (recentRate > priorRate + 0.05) trend = "worsening";
    else trend = "flat";
    rows.push({
      category,
      recentCount: r.count,
      recentRuns: recent.length,
      priorCount: p.count,
      priorRuns: prior.length,
      recentRate: Math.round(recentRate * 100) / 100,
      priorRate: Math.round(priorRate * 100) / 100,
      trend,
      lfRecent: Math.round(r.lf * 10) / 10,
      lfPrior: Math.round(p.lf * 10) / 10,
    });
  }
  // Worst problems first: highest recent rate, then highest prior.
  rows.sort((a, b) => b.recentRate - a.recentRate || b.priorRate - a.priorRate);
  return rows;
}
