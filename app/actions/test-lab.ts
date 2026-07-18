"use server";

/**
 * Admin accuracy lab — server actions.
 *
 * The lab runs the SAME address→gutters engine users get (one code path,
 * zero forks), but as a SUPER_ADMIN surface: no credits, no abuse rails,
 * and the run's raw solar inputs are snapshotted so the exact roof can be
 * REPLAYED offline against future engine versions and scored against the
 * admin's corrected ground truth.
 *
 * Data flow per run:
 *   runLabEstimate      → engine output + layers snapshot stored, PENDING
 *   finalizeLabRun      → corrected geometry + click-tags → diff + feedback,
 *                         status APPROVED (clean) or CORRECTED
 *   retestLabRun        → replay stored layers through the CURRENT engine,
 *                         score vs ground truth, save lastScoreJson
 */

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getMe } from "./me";
import { runAIEstimatePipeline } from "@/lib/ai";
import { runSolarFirstEstimate } from "@/lib/ai/solar-engine";
import type { SolarLayers } from "@/lib/ai/solar-layers";
import type { BuildingInsights } from "@/lib/ai/solar";
import {
  deserializeSolarLayers,
  serializeSolarLayers,
} from "@/lib/test-lab/layers-io";
import { computeLabDiff, type LabGeometry } from "@/lib/test-lab/diff";
import { buildFeedback, type LabTag } from "@/lib/test-lab/feedback";
import { scoreAgainstTruth, type LabScore } from "@/lib/test-lab/score";
import type { Downspout, EditableLine, Measurements, RoofStructure } from "@/lib/types";

async function requireAdmin() {
  const me = await getMe();
  if (!me || me.user.role !== "SUPER_ADMIN") {
    throw new Error("Forbidden");
  }
  return me;
}

const engineVersion = () =>
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";

/** Everything engineJson stores — the run's geometry minus the big aerial
 *  data URL (its own column) and minus the raw layers (layersData). */
type EngineSnapshot = {
  measurements: Measurements;
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
  suggestedEaves: EditableLine[];
  roofStructure: RoofStructure | null;
  magnetPath: { x: number; y: number }[];
  magnetRingCount: number;
  traceQuality: unknown;
  source: string;
};

export type LabRunDetail = {
  id: string;
  address: string;
  status: "PENDING" | "APPROVED" | "CORRECTED";
  createdAt: string;
  engine: EngineSnapshot;
  corrected: LabGeometry | null;
  tags: LabTag[];
  diff: unknown | null;
  aerial: { imageDataUrl: string; width: number; height: number } | null;
  canvasPxPerFt: number;
  notes: string[];
  replayable: boolean;
  engineVersion: string | null;
  lastScore: (LabScore & { scoredAt?: string; engineVersion?: string }) | null;
};

export type LabRunSummary = {
  id: string;
  address: string;
  status: "PENDING" | "APPROVED" | "CORRECTED";
  createdAt: string;
  engineEaveLF: number;
  correctedEaveLF: number | null;
  changeCount: number | null;
  replayable: boolean;
  engineVersion: string | null;
  lastScore: { scorePct: number; clean: boolean; scoredAt: string; engineVersion?: string } | null;
};

export type LabAggregate = {
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  scored: number;
  avgScorePct: number | null;
  cleanCount: number;
};

function rowToDetail(row: {
  id: string;
  address: string;
  status: string;
  createdAt: Date;
  engineJson: unknown;
  correctedJson: unknown;
  tagsJson: unknown;
  diffJson: unknown;
  notesJson: unknown;
  aerialData: string | null;
  aerialW: number | null;
  aerialH: number | null;
  canvasPxPerFt: number | null;
  layersData: string | null;
  engineVersion: string | null;
  lastScoreJson: unknown;
}): LabRunDetail {
  return {
    id: row.id,
    address: row.address,
    status: row.status as LabRunDetail["status"],
    createdAt: row.createdAt.toISOString(),
    engine: row.engineJson as EngineSnapshot,
    corrected: (row.correctedJson as LabGeometry | null) ?? null,
    tags: (row.tagsJson as LabTag[] | null) ?? [],
    diff: row.diffJson ?? null,
    aerial: row.aerialData
      ? {
          imageDataUrl: row.aerialData,
          width: row.aerialW ?? 0,
          height: row.aerialH ?? 0,
        }
      : null,
    canvasPxPerFt: row.canvasPxPerFt ?? 2.4,
    notes: (row.notesJson as string[] | null) ?? [],
    replayable: !!row.layersData,
    engineVersion: row.engineVersion,
    lastScore:
      (row.lastScoreJson as LabRunDetail["lastScore"]) ?? null,
  };
}

/** Run the real pipeline on an address and snapshot everything. */
export async function runLabEstimate(
  address: string,
): Promise<{ ok: true; run: LabRunDetail } | { ok: false; error: string }> {
  const me = await requireAdmin();
  const trimmed = address.trim();
  if (trimmed.length < 5) return { ok: false, error: "Enter a full address." };

  type SolarCapture = {
    layers: SolarLayers;
    insights: BuildingInsights | null;
    lat: number;
    lng: number;
  };
  // Assigned inside the pipeline callback — hidden behind a holder so TS
  // doesn't narrow it to null across the await.
  const holder: { cap: SolarCapture | null } = { cap: null };

  const t0 = Date.now();
  let result;
  try {
    result = await runAIEstimatePipeline(trimmed, {
      onSolarCapture: (cap) => {
        holder.cap = cap;
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: `Engine failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Serialize the raw inputs while the run is hot. Never let a snapshot
  // problem lose the run itself.
  const captured = holder.cap;
  let layersData: string | null = null;
  try {
    if (captured) layersData = serializeSolarLayers(captured.layers);
  } catch (e) {
    console.warn("[test-lab] layers snapshot failed:", e);
  }

  const engine: EngineSnapshot = {
    measurements: result.measurements,
    eaves: result.eaves,
    rakes: result.rakes,
    downspouts: result.downspouts,
    suggestedEaves: result.suggestedEaves ?? [],
    roofStructure: result.roofStructure ?? null,
    magnetPath: result.magnetPath ?? [],
    magnetRingCount: result.magnetRingCount ?? 0,
    traceQuality: result.traceQuality ?? null,
    source: result.source,
  };

  const row = await db.testLabRun.create({
    data: {
      userId: me.user.id,
      address: trimmed,
      lat: captured?.lat ?? result.geocoded?.lat ?? null,
      lng: captured?.lng ?? result.geocoded?.lng ?? null,
      engineJson: engine as unknown as Prisma.InputJsonValue,
      notesJson: result.notes as unknown as Prisma.InputJsonValue,
      aerialData: result.aerial?.imageDataUrl ?? null,
      aerialW: result.aerial?.width ?? null,
      aerialH: result.aerial?.height ?? null,
      canvasPxPerFt: result.canvasPxPerFt ?? null,
      layersData,
      insightsJson: captured?.insights
        ? (captured.insights as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      engineVersion: engineVersion(),
      runDurationMs: Date.now() - t0,
    },
  });

  revalidatePath("/admin/test-lab");
  return { ok: true, run: rowToDetail(row) };
}

/** Save the admin's verdict: approved as-is, or corrected ground truth. */
export async function finalizeLabRun(args: {
  id: string;
  corrected: LabGeometry;
  tags: LabTag[];
}): Promise<
  | { ok: true; status: "APPROVED" | "CORRECTED"; diff: unknown; feedback: unknown }
  | { ok: false; error: string }
> {
  await requireAdmin();
  const row = await db.testLabRun.findFirst({ where: { id: args.id } });
  if (!row || !row.engineJson) return { ok: false, error: "Run not found." };

  const engine = row.engineJson as unknown as EngineSnapshot;
  const before: LabGeometry = {
    eaves: engine.eaves ?? [],
    rakes: engine.rakes ?? [],
    downspouts: engine.downspouts ?? [],
  };
  const pxPerFt = row.canvasPxPerFt ?? 2.4;
  const diff = computeLabDiff(before, args.corrected, pxPerFt);
  const feedback = buildFeedback(diff, args.tags);
  const status = diff.isClean ? "APPROVED" : "CORRECTED";

  await db.testLabRun.update({
    where: { id: row.id },
    data: {
      status,
      correctedJson: args.corrected as unknown as Prisma.InputJsonValue,
      tagsJson: args.tags as unknown as Prisma.InputJsonValue,
      diffJson: { ...diff, feedback } as unknown as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/admin/test-lab");
  return { ok: true, status, diff, feedback };
}

/** Replay a finalized run's stored layers through the CURRENT engine and
 *  score the fresh output against the admin's ground truth. */
export async function retestLabRun(
  id: string,
): Promise<
  | { ok: true; score: LabScore & { engineReturnedNull?: boolean }; previous: { scorePct: number } | null; notes: string[] }
  | { ok: false; error: string }
> {
  await requireAdmin();
  const row = await db.testLabRun.findFirst({ where: { id } });
  if (!row) return { ok: false, error: "Run not found." };
  if (row.status === "PENDING") {
    return { ok: false, error: "Finalize the run first — a re-test needs your ground truth." };
  }
  if (!row.layersData || row.lat == null || row.lng == null) {
    return { ok: false, error: "Not replayable — this run came from the legacy fallback path." };
  }

  let layers: SolarLayers;
  try {
    layers = deserializeSolarLayers(row.layersData);
  } catch (e) {
    return { ok: false, error: `Layers snapshot unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const notes: string[] = [];
  let replay = null;
  try {
    replay = await runSolarFirstEstimate({
      lat: row.lat,
      lng: row.lng,
      insights: (row.insightsJson as unknown as BuildingInsights | null) ?? null,
      notes,
      layersOverride: layers,
      // Freeze the staleness clock at the original run time so imagery
      // that was fresh then never starts failing the age gate on replays.
      nowMs: row.createdAt.getTime(),
    });
  } catch (e) {
    notes.push(`Replay errored: ${e instanceof Error ? e.message : String(e)}`);
  }

  const truth = (row.correctedJson as unknown as LabGeometry | null) ?? null;
  if (!truth) return { ok: false, error: "No ground truth stored on this run." };

  const originalEngine = row.engineJson as unknown as EngineSnapshot;
  const truthAnchor = perimeterCenter(originalEngine?.roofStructure ?? null);
  const engineAnchor = perimeterCenter(replay?.roofStructure ?? null);

  const score: LabScore & { engineReturnedNull?: boolean } = scoreAgainstTruth(
    {
      eaves: replay?.eaves ?? [],
      downspouts: (replay?.downspouts ?? []).map((d) => ({ x: d.x, y: d.y })),
      pxPerFt: replay?.canvasPxPerFt ?? row.canvasPxPerFt ?? 2.4,
      anchor: engineAnchor,
    },
    {
      eaves: truth.eaves ?? [],
      downspouts: (truth.downspouts ?? []).map((d) => ({ x: d.x, y: d.y })),
      pxPerFt: row.canvasPxPerFt ?? 2.4,
      anchor: truthAnchor,
    },
  );
  if (!replay) score.engineReturnedNull = true;

  const previous =
    (row.lastScoreJson as { scorePct: number } | null) ?? null;

  await db.testLabRun.update({
    where: { id: row.id },
    data: {
      lastScoreJson: {
        ...score,
        engineVersion: engineVersion(),
        scoredAt: new Date().toISOString(),
      } as unknown as Prisma.InputJsonValue,
      lastScoredAt: new Date(),
    },
  });

  revalidatePath("/admin/test-lab");
  return { ok: true, score, previous, notes };
}

function perimeterCenter(
  rs: RoofStructure | null,
): { x: number; y: number } | null {
  const ring = rs?.perimeter?.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (!ring || ring.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export async function listLabRuns(): Promise<{
  runs: LabRunSummary[];
  aggregate: LabAggregate;
}> {
  await requireAdmin();
  const rows = await db.testLabRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      address: true,
      status: true,
      createdAt: true,
      engineJson: true,
      diffJson: true,
      layersData: true,
      engineVersion: true,
      lastScoreJson: true,
      canvasPxPerFt: true,
    },
  });

  const runs: LabRunSummary[] = rows.map((r) => {
    const engine = r.engineJson as unknown as EngineSnapshot | null;
    const diff = r.diffJson as unknown as {
      eaveLFAfter?: number;
      changes?: unknown[];
      downspoutChanges?: unknown[];
    } | null;
    const score = r.lastScoreJson as unknown as {
      scorePct: number;
      clean: boolean;
      scoredAt: string;
      engineVersion?: string;
    } | null;
    return {
      id: r.id,
      address: r.address,
      status: r.status as LabRunSummary["status"],
      createdAt: r.createdAt.toISOString(),
      engineEaveLF: engine?.measurements?.eaveLF ?? 0,
      correctedEaveLF: diff?.eaveLFAfter ?? null,
      changeCount: diff
        ? (diff.changes?.length ?? 0) + (diff.downspoutChanges?.length ?? 0)
        : null,
      replayable: !!r.layersData,
      engineVersion: r.engineVersion,
      lastScore: score,
    };
  });

  const scored = runs.filter((r) => r.lastScore);
  const aggregate: LabAggregate = {
    total: runs.length,
    pending: runs.filter((r) => r.status === "PENDING").length,
    approved: runs.filter((r) => r.status === "APPROVED").length,
    corrected: runs.filter((r) => r.status === "CORRECTED").length,
    scored: scored.length,
    avgScorePct:
      scored.length > 0
        ? Math.round(
            scored.reduce((s, r) => s + (r.lastScore?.scorePct ?? 0), 0) /
              scored.length,
          )
        : null,
    cleanCount: scored.filter((r) => r.lastScore?.clean).length,
  };

  return { runs, aggregate };
}

export async function getLabRun(
  id: string,
): Promise<{ ok: true; run: LabRunDetail } | { ok: false; error: string }> {
  await requireAdmin();
  const row = await db.testLabRun.findFirst({ where: { id } });
  if (!row) return { ok: false, error: "Run not found." };
  return { ok: true, run: rowToDetail(row) };
}

export async function deleteLabRun(
  id: string,
): Promise<{ ok: boolean }> {
  await requireAdmin();
  await db.testLabRun.deleteMany({ where: { id } });
  revalidatePath("/admin/test-lab");
  return { ok: true };
}
