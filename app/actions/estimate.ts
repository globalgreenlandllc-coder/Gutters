"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runAIEstimatePipeline, type EstimateResult } from "@/lib/ai";
import { blueprintToEstimateResult } from "@/lib/ai/blueprint-to-estimate";
import type { BlueprintAnalysis } from "@/lib/ai/blueprint-from-plans";
import {
  extractBuildingOutline,
  outlineEdgesToRuns,
} from "@/lib/ai/outline-from-vectors";
import { getMe } from "./me";

// Note: the 90s function timeout for this server action is set on
// app/estimate/layout.tsx (maxDuration export). "use server" files
// can only export async functions, so the duration config has to live
// alongside the page that triggers it.

/**
 * Most recent unique addresses this contractor has run estimates on.
 * Powers the autocomplete dropdown on the dashboard's address input —
 * the same address rarely needs a full retype.
 *
 * Returns the *display* form (`row.address`, which is whatever the user
 * entered, after geocode normalization on success) rather than the
 * normalized lowercase key, so the dropdown reads the way the user
 * originally typed it.
 */
export async function getRecentAddresses(): Promise<string[]> {
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch {
    return [];
  }
  if (!me) return [];

  const rows = await db.estimateRun.findMany({
    where: { userId: me.user.id, status: "SUCCEEDED" },
    orderBy: { createdAt: "desc" },
    select: { address: true, addressNormalized: true },
    take: 50,
  });

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const key = r.addressNormalized || r.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.address);
    if (out.length >= 8) break;
  }
  return out;
}

export type RunEstimateResponse =
  | {
      ok: true;
      result: EstimateResult;
      reused: boolean;
      remaining: number;
      runId: string;
    }
  | {
      // Plan analysis is queued / still running in the after()
      // background callback. The caller should poll, NOT surface this
      // as an error.
      ok: false;
      pending: true;
      reason: string;
      remaining: number;
    }
  | {
      ok: false;
      pending?: false;
      reason: string;
      remaining: number;
    };

const TWENTY_FOUR_HOURS = 24 * 3600 * 1000;
const SAME_ADDRESS_DAILY_LIMIT = 10;

export async function runEstimate(
  address: string,
): Promise<RunEstimateResponse> {
  const trimmed = address.trim();
  if (!trimmed) {
    return { ok: false, reason: "Address is required", remaining: 0 };
  }

  // Wrap session lookup so a transient DB / Clerk failure surfaces as a
  // readable reason string instead of throwing past the page boundary.
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch (e) {
    console.error("[runEstimate] getMe failed", e);
    const msg = e instanceof Error ? e.message : "Session lookup failed";
    return { ok: false, reason: msg, remaining: 0 };
  }
  if (!me) {
    return { ok: false, reason: "Not signed in", remaining: 0 };
  }

  const userId = me.user.id;
  const norm = trimmed.toLowerCase();
  const since = new Date(Date.now() - TWENTY_FOUR_HOURS);
  // SUPER_ADMIN bypasses both credit accounting and the same-address
  // daily cap. They're internal users running QA, demos, and bug-repros
  // — counting those against a 12/month wallet makes the tool unusable
  // for the team that owns it.
  const isAdmin = me.user.role === "SUPER_ADMIN";

  const totalCredits = me.credits.included + me.credits.bonus;
  const remainingBefore = isAdmin
    ? Number.POSITIVE_INFINITY
    : Math.max(totalCredits - me.credits.used, 0);

  const recentSame = await db.estimateRun.count({
    where: { userId, addressNormalized: norm, createdAt: { gte: since } },
  });

  if (!isAdmin && recentSame >= SAME_ADDRESS_DAILY_LIMIT) {
    return {
      ok: false,
      reason: `This address has been re-run ${SAME_ADDRESS_DAILY_LIMIT} times in the last 24 hours.`,
      remaining: remainingBefore,
    };
  }

  const isReused = recentSame > 0;
  if (!isAdmin && !isReused && remainingBefore <= 0) {
    return {
      ok: false,
      reason: "Out of credits — top up or wait until your next renewal.",
      remaining: 0,
    };
  }

  let result: EstimateResult;
  try {
    result = await runAIEstimatePipeline(trimmed);
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI pipeline failed";
    await db.estimateRun.create({
      data: {
        userId,
        address: trimmed,
        addressNormalized: norm,
        status: "FAILED",
        creditConsumed: false,
        reused: isReused,
        errorMessage: message,
      },
    });
    return { ok: false, reason: message, remaining: remainingBefore };
  }

  // Admins still log the run (we want the audit trail + dashboards) but
  // creditConsumed is always false so the wallet stays untouched.
  const consumesCredit = !isReused && !isAdmin;

  const writes: Prisma.PrismaPromise<unknown>[] = [
    db.estimateRun.create({
      data: {
        userId,
        address: result.geocoded.formatted,
        addressNormalized: norm,
        status: "SUCCEEDED",
        creditConsumed: consumesCredit,
        reused: isReused,
        durationMs: result.durationMs,
        measurements: result.measurements as unknown as Prisma.InputJsonValue,
      },
    }),
  ];
  if (consumesCredit) {
    writes.push(
      db.creditWallet.update({
        where: { userId },
        data: { used: { increment: 1 } },
      }),
    );
  }
  const [created] = (await db.$transaction(writes)) as [{ id: string }];

  const remainingAfter = consumesCredit
    ? Math.max(remainingBefore - 1, 0)
    : remainingBefore;

  return {
    ok: true,
    result,
    reused: isReused,
    remaining: remainingAfter,
    runId: created.id,
  };
}

/**
 * Loads a saved PlanAnalysis (from /dashboard/blueprints upload) and
 * projects it into the same EstimateResult shape /estimate normally
 * gets from the address pipeline. Lets the contractor edit/save/send
 * a proposal from a plan exactly the way they would from a satellite-
 * derived estimate.
 *
 * No credit consumed — the blueprint pipeline is free per product call.
 */
export async function runEstimateFromPlan(
  planId: string,
): Promise<RunEstimateResponse> {
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch (e) {
    console.error("[runEstimateFromPlan] getMe failed", e);
    const msg = e instanceof Error ? e.message : "Session lookup failed";
    return { ok: false, reason: msg, remaining: 0 };
  }
  if (!me) return { ok: false, reason: "Not signed in", remaining: 0 };

  const isAdmin = me.user.role === "SUPER_ADMIN";
  const totalCredits = me.credits.included + me.credits.bonus;
  const remaining = isAdmin
    ? Number.POSITIVE_INFINITY
    : Math.max(totalCredits - me.credits.used, 0);

  const row = await db.planAnalysis.findFirst({
    where: { id: planId, userId: me.user.id },
  });
  if (!row) {
    return { ok: false, reason: "Plan analysis not found", remaining };
  }
  if (row.status === "QUEUED") {
    return {
      ok: false,
      pending: true,
      reason: "Plan analysis is still in progress",
      remaining,
    };
  }
  if (row.status !== "SUCCEEDED" || !row.analysisJson) {
    return {
      ok: false,
      reason: row.errorMessage ?? "Plan analysis failed",
      remaining,
    };
  }

  const analysis = row.analysisJson as unknown as BlueprintAnalysis;

  // COPY the building outline from the PDF's vector layer (the drawn walls on
  // the foundation/floor plan) instead of using the AI's reconstructed
  // footprint, which flattens to a box. The segments were already extracted at
  // analysis time (_vectorGeometry.footprint). When we recover a believable
  // outline, it BECOMES the footprint + the eave runs (geometry from the
  // drawing); the AI's runs only lend their tier/feature labels. Fully
  // fail-safe: any miss leaves the AI geometry untouched.
  try {
    const aj = row.analysisJson as {
      _vectorGeometry?: { footprint?: { segments?: number[][] } };
      _classifier?: {
        classification?: {
          building_dimensions?: { width_ft?: number | null; depth_ft?: number | null };
        };
      };
    } | null;
    const segs = aj?._vectorGeometry?.footprint?.segments;
    if (Array.isArray(segs) && segs.length >= 4) {
      const outline = extractBuildingOutline(segs);
      // Sanity: a real footprint is a handful of corners, not a blob.
      if (outline && outline.polygon.length >= 4 && outline.polygon.length <= 40) {
        const bb = outline.bbox;
        const dims = aj?._classifier?.classification?.building_dimensions;
        const maxFt = Math.max(dims?.width_ft ?? 0, dims?.depth_ft ?? 0);
        const maxPt = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
        const ptPerFt = maxFt > 0 && maxPt > 0 ? maxPt / maxFt : null;
        const aiRuns = (analysis.gutter_runs ?? []).map((r) => ({
          start: r.start,
          end: r.end,
          tier: r.tier,
          feature: r.feature,
          side: r.side,
        }));
        const edges = outlineEdgesToRuns(outline.polygon, aiRuns);
        analysis.building_footprint = outline.polygon.map((p) => ({ x: p.x, y: p.y }));
        analysis.gutter_runs = edges.map((e, i) => {
          const len = Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y);
          return {
            id: `veave-${i}`,
            side: (e.side ?? "front") as BlueprintAnalysis["gutter_runs"][number]["side"],
            start: e.start,
            end: e.end,
            length_px: len,
            length_ft: ptPerFt ? Math.round((len / ptPerFt) * 10) / 10 : null,
            drains_to: [],
            tier: e.tier as BlueprintAnalysis["gutter_runs"][number]["tier"],
            feature: e.feature as BlueprintAnalysis["gutter_runs"][number]["feature"],
          };
        });
        analysis.notes = [
          ...(analysis.notes ?? []),
          `Roof outline copied from the plan's vector layer (${outline.polygon.length} corners) — gutters inherit the AI's tier/porch labels; trim any gable faces on the canvas.`,
        ];
      }
    }
  } catch {
    // keep the AI geometry on any failure
  }

  // Surface the classifier's sheet inventory so the takeoff canvas can let
  // the contractor flip the PDF underlay to the right drawing (roof plan
  // vs foundation/floor), each labelled.
  const TYPE_LABEL: Record<string, string> = {
    roof_plan: "Roof plan",
    floor_plan: "Floor / foundation",
    elevation: "Elevation",
    section: "Section",
    site_plan: "Site plan",
    detail: "Detail",
    cover: "Cover",
    unknown: "Sheet",
  };
  const cls = (
    row.analysisJson as {
      _classifier?: {
        classification?: {
          sheets?: Array<{
            page_index: number;
            sheet_type: string;
            sheet_label: string | null;
          }>;
        };
      };
    } | null
  )?._classifier?.classification;
  const sheets = (cls?.sheets ?? [])
    .filter((s) => Number.isFinite(s.page_index))
    .map((s) => {
      const type = TYPE_LABEL[s.sheet_type] ?? "Sheet";
      return {
        pageIndex: s.page_index,
        label: s.sheet_label ? `${type} (${s.sheet_label})` : type,
      };
    });
  const pageCount =
    row.pageCount ??
    (sheets.length ? Math.max(...sheets.map((s) => s.pageIndex)) : undefined);

  const result = blueprintToEstimateResult(analysis, {
    filename: row.filename,
    durationMs: row.durationMs ?? undefined,
    planId: row.id,
    pageCount,
    sheets,
  });

  return {
    ok: true,
    result,
    reused: true, // not chargeable; surface as "reused" in the UI badge
    remaining,
    runId: row.id,
  };
}
