"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runAIEstimatePipeline, type EstimateResult } from "@/lib/ai";
import { blueprintToEstimateResult } from "@/lib/ai/blueprint-to-estimate";
import { engineDrawEnabled, engineTakeoffEnabled, perimeterOnlyEnabled } from "@/lib/ai/engine-takeoff";
import type { BlueprintAnalysis } from "@/lib/ai/blueprint-from-plans";
import { extractBuildingOutline, deriveVectorScale } from "@/lib/ai/outline-from-vectors";
import { rectifyPlanFootprint, auditNotches } from "@/lib/ai/rectify-plan-takeoff";
import { tierCornerVeto } from "@/lib/ai/tier-corner-veto";
import { reconcileEaveSteps } from "@/lib/ai/eave-step-reconcile";
import { humanizeAiError } from "@/lib/ai/humanize-error";
import { readRoofFromVectors } from "@/lib/ai/roof-from-vectors";
import { deriveOrientationFromFaceTitles } from "@/lib/ai/plan-orientation";
import { closeVectorPerimeter } from "@/lib/ai/reconcile-eaves";
import { explainUnanimousHip } from "@/lib/ai/face-merge";
import {
  parseRoofPlanReading,
  mergeLayoutEvidence,
  roofPlanUnanimousHip,
  roofPlanDsFloor,
} from "@/lib/ai/read-roof-layout";
import { polygonCloses } from "@/lib/roof-engine";
import { buildEdgeTakeoff } from "@/lib/ai/edge-takeoff";
import { outlineEdges, downspoutMarksFromLabels } from "@/lib/ai/plan-overlay";
import { crossCheckScaleAgainstOveralls } from "@/lib/ai/dim-scale";
import { edgeTakeoffEnabled, type EdgeClassification } from "@/lib/ai/classify-edges";
import { suppressUnevidencedInterior, type RoofLayout } from "@/lib/ai/roof-layout";
import { consumeLimit } from "@/lib/abuse/rate-limit";
import { POLICIES, EST_COST_CENTS } from "@/lib/abuse/policies";
import { checkAiSpendAllowed, recordSpend } from "@/lib/abuse/spend-guard";
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

// Whole-pipeline deadline. Each upstream call is individually bounded
// (lib/ai/http.ts), but a run where several are slow at once could still
// stack past the 90s Vercel maxDuration and be killed mid-flight — which
// surfaces to the user as an opaque 504 / "we couldn't run that estimate".
// Racing against a deadline a comfortable margin under 90s guarantees we
// return a clean, retryable error instead. The orphaned pipeline promise is
// harmless: the function is torn down at maxDuration regardless, and a
// failed run is already spend-ledgered below.
const PIPELINE_DEADLINE_MS = 82_000;
const PIPELINE_DEADLINE_MESSAGE =
  "The estimate took too long and was stopped before finishing — usually a " +
  "temporarily slow imagery or AI service. Please try again.";

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // clearTimeout so a fast success doesn't leave the timer holding the
  // serverless function alive until it fires.
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  // SUPER_ADMIN bypasses the same-address daily cap and the rate limits
  // — internal users running QA, demos, and bug-repros.
  const isAdmin = me.user.role === "SUPER_ADMIN";

  // Address estimates are FREE on every plan — the credit wallet only
  // meters blueprint takeoffs. `remaining` still reports the blueprint-
  // credit balance so callers can display it.
  const totalCredits = me.credits.included + me.credits.bonus;
  const remainingCredits = isAdmin
    ? Number.POSITIVE_INFINITY
    : Math.max(totalCredits - me.credits.used, 0);

  // With no wallet gate, the abuse rails are what actually bound free
  // usage. Cheapest first: request-rate limit (10/hr, 30/day per user),
  // then the cost-aware spend gate (per-user daily cents + global
  // circuit breaker). Both fail CLOSED — this action spends real money
  // on Solar/SAM-2/GPT-4o.
  if (!isAdmin) {
    const rl = await consumeLimit({
      policy: POLICIES.estimateRun,
      key: `user:${userId}`,
      context: { userId, route: "runEstimate" },
    });
    if (!rl.ok) {
      return { ok: false, reason: rl.reason, remaining: remainingCredits };
    }
  }
  const spend = await checkAiSpendAllowed({
    userId,
    kind: "SATELLITE_ESTIMATE",
    estCostCents: EST_COST_CENTS.SATELLITE_ESTIMATE,
    isAdmin,
  });
  if (!spend.ok) {
    return { ok: false, reason: spend.reason, remaining: remainingCredits };
  }

  const recentSame = await db.estimateRun.count({
    where: { userId, addressNormalized: norm, createdAt: { gte: since } },
  });

  if (!isAdmin && recentSame >= SAME_ADDRESS_DAILY_LIMIT) {
    return {
      ok: false,
      reason: `This address has been re-run ${SAME_ADDRESS_DAILY_LIMIT} times in the last 24 hours.`,
      remaining: remainingCredits,
    };
  }

  const isReused = recentSame > 0;

  let result: EstimateResult;
  try {
    result = await withDeadline(
      runAIEstimatePipeline(trimmed),
      PIPELINE_DEADLINE_MS,
      PIPELINE_DEADLINE_MESSAGE,
    );
  } catch (e) {
    // A failed pipeline still burned geocode/Solar/tile/SAM-2 calls —
    // ledger it so a bot fishing with bad addresses can't spend for free.
    await recordSpend({
      userId,
      kind: "SATELLITE_ESTIMATE",
      costCents: EST_COST_CENTS.SATELLITE_ESTIMATE,
      meta: { address: norm, failed: true },
    });
    // Raw cause to the server log; users get the humanized (and for
    // billing/auth failures, deliberately generic) message.
    console.error("[runEstimate] pipeline failed:", e);
    const message = humanizeAiError(
      e instanceof Error ? e.message : "AI pipeline failed",
    );
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
    return { ok: false, reason: message, remaining: remainingCredits };
  }

  // Every run is logged (audit trail + dashboards) but the wallet is
  // never touched — address estimates don't consume blueprint credits.
  const created = await db.estimateRun.create({
    data: {
      userId,
      address: result.geocoded.formatted,
      addressNormalized: norm,
      status: "SUCCEEDED",
      creditConsumed: false,
      reused: isReused,
      durationMs: result.durationMs,
      measurements: result.measurements as unknown as Prisma.InputJsonValue,
    },
  });

  await recordSpend({
    userId,
    kind: "SATELLITE_ESTIMATE",
    costCents: EST_COST_CENTS.SATELLITE_ESTIMATE,
    meta: { address: norm, reused: isReused, runId: created.id },
  });

  // The engine's stage-by-stage log ("Trimmed N m² …", "Snapped N
  // walls …") is an internal diagnostic — ADMIN eyes only. Contractors
  // get the clean result; anything they must act on still arrives via
  // traceQuality and the double-check banner.
  if (!isAdmin) result.notes = [];

  return {
    ok: true,
    result,
    reused: isReused,
    remaining: remainingCredits,
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
 * No credit consumed HERE — the blueprint credit is charged when the
 * plan is analyzed (POST /api/blueprints, on success). Loading the
 * saved analysis into the estimate view is free, like a re-run.
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

  // LAST AUTO SHOT — read the WHOLE roof from the SINGLE A9 roof-framing sheet,
  // so the footprint + the gables come from ONE coordinate space and self-align
  // (instead of stitching the A4 footprint to the A9 classification — two pages,
  // two coord systems, gables never line up). The A9 bold segments + GABLE text
  // labels were already extracted at analysis time (_vectorGeometry.roof). When
  // it yields a believable articulated outline, it BECOMES the footprint, the
  // AI runs remap onto it, and each edge a GABLE label points at is demoted to a
  // rake (no gutter). Tried FIRST; ANY miss falls through to the A4 block below
  // (then to AI geometry) unchanged. Fully fail-safe — never blank, never worse.
  // Diagnostic trace of the vector-footprint swap. Logged + surfaced as a note
  // so a run that falls back to the AI trace shows EXACTLY why (segments absent,
  // read rejected by a gate, outline too few corners). Without this the swap was
  // a SILENT no-op and there was no way to tell why the flattened trace won.
  const vecTrace: string[] = [];
  let footprintSource = "AI trace (best-of read)";
  let roofApplied = false;

  // v2 EDGE TAKEOFF — when the analysis stored a successful per-edge
  // classification (classify-edges.ts), the takeoff is rebuilt WHOLESALE from
  // the plan's own outline + the classifier's labels: exact edge lengths at
  // the dimension-line-solved scale, rakes carry no gutter, downspouts at the
  // sheet's D.S. marks, and unknown edges stay visibly UNPRICED. The freehand
  // run remap, prose scale anchor, and blind closure default are all skipped —
  // they are the error sources v2 exists to remove. Fail-safe: anything
  // missing → v1 path unchanged.
  let edgeApplied = false;
  let edgeLayout: RoofLayout | null = null;
  // Projecting masses (porch/patio/garage on posts/beam) whose own gutters
  // sit beyond the traced outline — passed to the estimate assembler so it
  // can synthesize an ESTIMATED gutter line from the roof-area schedule
  // instead of dropping the LF (the Woodinville garage-jog hole).
  let droppedProjections: NonNullable<EdgeClassification["droppedProjections"]> = [];
  if (edgeTakeoffEnabled()) {
    try {
      const stash = (row.analysisJson as { _edgeTakeoff?: EdgeClassification })
        ?._edgeTakeoff;
      if (
        stash?.ok &&
        stash.ptPerFt &&
        Number.isFinite(stash.ptPerFt) &&
        Array.isArray(stash.outline) &&
        stash.outline.length >= 3 &&
        Array.isArray(stash.classes) &&
        stash.classes.some((c) => c.edge_class === "eave")
      ) {
        const edges = outlineEdges(stash.outline);
        // D.S. union: the sheet's own extracted text layer often has the
        // printed "D.S." strings with exact coordinates (same pt space as
        // the outline — both come from the footprint page). A dense sheet
        // can defeat the vision count PARTWAY (not just entirely), so text
        // marks are UNIONED with the vision marks: any printed mark farther
        // than ~4 ft from every vision mark is added — vision marks are
        // never moved or removed. Beats the 1-per-40 ft synthesis either way.
        let dsMarks = stash.downspouts ?? [];
        let dsTextNote: string | null = null;
        {
          const fpLabels = (
            row.analysisJson as {
              _vectorGeometry?: {
                footprint?: { labels?: { s: string; x: number; y: number }[] };
              };
            } | null
          )?._vectorGeometry?.footprint?.labels;
          const textMarks = downspoutMarksFromLabels(fpLabels, edges, stash.ptPerFt);
          if (textMarks.length > 0) {
            const at = (m: { edge_id: string; frac: number }) => {
              const e = edges.find((x) => x.id === m.edge_id);
              return e
                ? {
                    x: e.p1.x + (e.p2.x - e.p1.x) * m.frac,
                    y: e.p1.y + (e.p2.y - e.p1.y) * m.frac,
                  }
                : null;
            };
            const minGapPt = stash.ptPerFt * 4; // ~4 ft — same spirit as the label MERGE gap
            const existing = dsMarks
              .map(at)
              .filter((p): p is { x: number; y: number } => p !== null);
            const added = textMarks.filter((m) => {
              const p = at(m);
              return (
                !!p &&
                existing.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > minGapPt)
              );
            });
            if (added.length > 0) {
              const sawBefore = dsMarks.length;
              dsMarks = [...dsMarks, ...added];
              dsTextNote =
                sawBefore === 0
                  ? `💧 ${added.length} "D.S." mark(s) read from the plan's own text layer (the vision pass saw none) — downspouts placed at the printed marks, not the 1-per-40 ft rule. Verify count against the roof plan.`
                  : `💧 ${added.length} "D.S." mark(s) added from the plan's own text layer (the vision pass saw ${sawBefore}) — printed marks the vision read missed. Verify count against the roof plan.`;
            }
          }
        }
        const t = buildEdgeTakeoff({
          outline: stash.outline,
          edges,
          classes: stash.classes,
          ptPerFt: stash.ptPerFt,
          downspouts: dsMarks,
        });
        if (dsTextNote) t.notes.push(dsTextNote);
        // Scale sanity: the dimension-line solve is span ÷ VISION-read value —
        // one misread value scales every priced run. The text layer's printed
        // overalls are read deterministically; the outline's extent at the
        // solved scale must land near one. Flag-only (never rescales pricing).
        {
          const fpDims = (
            row.analysisJson as {
              _vectorGeometry?: { footprint?: { dimensions?: { s: string }[] } };
            } | null
          )?._vectorGeometry?.footprint?.dimensions;
          const sc = crossCheckScaleAgainstOveralls(
            stash.ptPerFt,
            stash.outline,
            fpDims?.map((d) => d.s),
          );
          if (sc.checked && !sc.consistent) {
            t.notes.push(
              `📏 SCALE MISMATCH: at ${Math.round(stash.ptPerFt * 100) / 100} pt/ft the footprint reads ${sc.impliedWFt} × ${sc.impliedHFt} ft, but the sheet's closest printed overall is ${sc.bestOverallFt}' (~${sc.mismatchPct}% off). The dimension-line solve may have read the wrong printed value — verify the total LF against the plan's printed overall dimensions before quoting.`,
            );
          }
        }
        analysis.building_footprint = stash.outline.map((p) => ({ x: p.x, y: p.y }));
        analysis.gutter_runs = t.gutter_runs;
        // Keep only the classifier's rakes — the AI's freehand interior lines
        // (ridge/hip/valley) are exactly the strokes v2 stops trusting; the
        // engine draws the interior by rule instead.
        analysis.excluded_edges = t.excluded_edges
          .filter((e) => e.kind === "rake")
          .map((e) => ({ kind: "rake" as const, start: e.start, end: e.end, reason: e.reason }));
        analysis.downspouts = t.downspouts.map((d, i) => ({
          id: `edge-ds-${i + 1}`,
          at: d.at,
          from_gutter: `edge-${d.edge_id}`,
          drop_direction: d.side === "interior" ? "front" : d.side,
          reason: "outside_corner" as const,
          drop_height_ft: d.drop_height_ft,
        }));
        analysis.totals = {
          ...analysis.totals,
          linear_feet_gutter: t.totals.eave_lf,
          downspout_count: t.downspouts.length,
          outside_corner_miters: t.totals.outside_corner_miters,
          inside_corner_miters: t.totals.inside_corner_miters,
        };
        analysis.scale = {
          unit: "pixels",
          feet_per_unit: 1 / stash.ptPerFt,
          source: stash.scaleSource ?? "dimension-line solve",
        };
        analysis.notes = [...(analysis.notes ?? []), ...t.notes];
        footprintSource = "edge-classified outline (v2)";
        vecTrace.push(
          `✓ EDGE TAKEOFF: ${t.gutter_runs.length} eave edge(s) = ${t.totals.eave_lf} LF, ` +
            `${analysis.excluded_edges.length} rake(s), ${t.unpricedIds.length} unpriced, ` +
            `${t.downspouts.length} D.S. @ ${Math.round(stash.ptPerFt * 100) / 100} pt/ft`,
        );
        edgeApplied = true;
        if (Array.isArray(stash.droppedProjections)) {
          droppedProjections = stash.droppedProjections;
        }
        // Interior geometry: ONLY the classifier-time layout. It was computed
        // WITH the sheet's vectors, so the evidence gate (discard a skeleton
        // the sheet contradicts) had its say — recomputing here without the
        // vectors would skip that gate and can draw a wrong-in-kind skeleton
        // on multi-pitch roofs. Older stashes without the field draw the
        // perimeter only until the next Re-analyze. Guard the array shapes:
        // this is free-form JSON from the DB; a malformed stash must degrade,
        // never crash the estimate.
        const stored = stash.layout;
        if (
          stored?.ok &&
          Array.isArray(stored.ridges) &&
          Array.isArray(stored.hips) &&
          Array.isArray(stored.valleys)
        ) {
          // Rows stored before the sheet-evidence discard learned ratios can
          // carry a skeleton the sheet mostly contradicts (the "random
          // lines"). Hide the unevidenced computed interior at view time;
          // sheet-adopted lines + gable ends stay. New rows pass through.
          edgeLayout = suppressUnevidencedInterior(stored);
          vecTrace.push(
            `📐 layout: ${edgeLayout.ridges.length} ridge / ${edgeLayout.hips.length} hip / ` +
              `${edgeLayout.valleys.length} valley, ${edgeLayout.gableCount} gable end(s)` +
              (edgeLayout !== stored ? " (unevidenced interior hidden)" : "") +
              (stored.diag
                ? `, diag match ${stored.diag.matchedPlan}/${stored.diag.planDiagonals}` +
                  ` +${stored.diag.adopted} adopted`
                : ""),
          );
        } else {
          vecTrace.push(
            stored
              ? `📐 layout not drawn (${stored.reason ?? "stored layout malformed"})`
              : "📐 layout not in stash (pre-layout analysis) — Re-analyze to draw the interior",
          );
        }
      } else if (stash) {
        const reason = stash.ok ? "no scale/eaves" : (stash.reason ?? "failed");
        vecTrace.push(`edge takeoff stored but not applied (${reason})`);
        // The classifier NEVER SAW this plan (API failure at analyze time) —
        // everything shown is the freehand fallback. That's a quoting hazard
        // the owner must see FIRST, not buried in a trace note: the 2026-07-10
        // run shipped wrong gable spots + unguttered sides this way when the
        // Anthropic account ran out of credits.
        if (!stash.ok) {
          const hint = /credit balance/i.test(reason)
            ? "the Anthropic API account is out of credits — add credits, then Re-analyze"
            : "fix the cause shown in the trace note, then Re-analyze";
          analysis.notes = [
            `🚨 TAKEOFF DEGRADED — the AI edge classifier never ran on this plan (${hint}). Runs, gable spots and downspouts below come from the freehand fallback and are NOT evidence-checked against the framing sheet or elevations.`,
            ...(analysis.notes ?? []),
          ];
        }
      }
    } catch (e) {
      vecTrace.push(
        `edge takeoff errored (${e instanceof Error ? e.message : "?"}) — v1 path`,
      );
    }
  }
  // Text the model may have echoed the plan's printed OVERALL dimension into —
  // used to re-anchor the swapped point-space outline to the sheet's real scale
  // (deriveVectorScale). Model wording varies (Opus writes "64'-0 OVERALL" into
  // scale.source; Gemini phrases it differently and it can land in a note), so
  // scan the source AND the ORIGINAL notes here, before our own note appends
  // dilute them with derived numbers.
  const scaleAnchorText = [
    analysis.scale?.source,
    ...(analysis.notes ?? []),
  ]
    .filter(Boolean)
    .join(" | ");
  if (!edgeApplied) try {
    const ajR = row.analysisJson as {
      _vectorGeometry?: {
        roof?: {
          segments?: number[][];
          labels?: { s: string; x: number; y: number }[];
        };
      };
    } | null;
    const rsegs = ajR?._vectorGeometry?.roof?.segments;
    const rlabels = ajR?._vectorGeometry?.roof?.labels ?? [];
    vecTrace.push(Array.isArray(rsegs) && rsegs.length >= 4 ? `A9 roof: ${rsegs.length} vector segs` : "A9 roof: no vector segments");
    if (Array.isArray(rsegs) && rsegs.length >= 4) {
      // Reject an A9 read whose SHAPE is wildly unlike the AI footprint (a
      // truss-blob floodfill happened to enclose) — pass the footprint aspect.
      const fp = analysis.building_footprint ?? [];
      let expectedAspect: number | undefined;
      if (fp.length >= 3) {
        let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
        for (const p of fp) {
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          fx0 = Math.min(fx0, p.x); fy0 = Math.min(fy0, p.y);
          fx1 = Math.max(fx1, p.x); fy1 = Math.max(fy1, p.y);
        }
        const w = fx1 - fx0, h = fy1 - fy0;
        if (w > 0 && h > 0) expectedAspect = Math.max(w, h) / Math.min(w, h);
      }
      const roof = readRoofFromVectors(
        rlabels,
        rsegs,
        expectedAspect ? { expectedAspect } : undefined,
      );
      vecTrace.push(
        !roof
          ? "A9 read REJECTED (aspect / fill-fraction / corner-count gate in readRoofFromVectors)"
          : `A9 outline ${roof.perimeter.length} corners${roof.perimeter.length > 4 && roof.perimeter.length <= 60 ? "" : " — outside the 5–60 gate, skipped"}`,
      );
      if (roof && roof.perimeter.length > 4 && roof.perimeter.length <= 60 && !polygonCloses(roof.perimeter)) {
        // A self-intersecting (bow-tie / pinched) ring draws garbage roof faces
        // and poisons every downstream consumer — never swap it in.
        vecTrace.push("A9 outline self-intersects — skipped");
      } else if (roof && roof.perimeter.length > 4 && roof.perimeter.length <= 60) {
        const poly = roof.perimeter;
        const pbb = roof.bbox;
        const aiPts = [
          ...analysis.gutter_runs.flatMap((r) => [r.start, r.end]),
          ...(analysis.excluded_edges ?? []).flatMap((e) => [e.start, e.end]),
        ].filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
        if (aiPts.length >= 2) {
          let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
          for (const p of aiPts) {
            ax0 = Math.min(ax0, p.x); ay0 = Math.min(ay0, p.y);
            ax1 = Math.max(ax1, p.x); ay1 = Math.max(ay1, p.y);
          }
          const sx = (pbb.x1 - pbb.x0) / Math.max(1e-6, ax1 - ax0);
          const sy = (pbb.y1 - pbb.y0) / Math.max(1e-6, ay1 - ay0);
          const T = (p: { x: number; y: number }) => ({
            x: pbb.x0 + (p.x - ax0) * sx,
            y: pbb.y0 + (p.y - ay0) * sy,
          });
          analysis.building_footprint = poly.map((p) => ({ x: p.x, y: p.y }));
          analysis.gutter_runs = analysis.gutter_runs.map((r) => ({
            ...r,
            start: T(r.start),
            end: T(r.end),
            length_px: Math.hypot(T(r.end).x - T(r.start).x, T(r.end).y - T(r.start).y),
          }));
          analysis.excluded_edges = (analysis.excluded_edges ?? []).map((e) => ({
            ...e,
            start: T(e.start),
            end: T(e.end),
          }));
          analysis.downspouts = (analysis.downspouts ?? []).map((d) => ({
            ...d,
            at: T(d.at),
          }));
          // For each edge a GABLE label points at, demote the NEAREST gutter_run
          // to a rake (no gutter) — distance-capped so it can never steal an
          // eave on the far side of the house. A bare edge with no nearby run
          // already reads as a gable to the client's deriveRoofSkeleton.
          const span = Math.max(pbb.x1 - pbb.x0, pbb.y1 - pbb.y0);
          const cap = 0.15 * span;
          const mid = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
            x: (p.x + q.x) / 2,
            y: (p.y + q.y) / 2,
          });
          const np = poly.length;
          let gableMarks = 0;
          for (let i = 0; i < np; i++) {
            if (!roof.gableFlags[i]) continue;
            const em = mid(poly[i], poly[(i + 1) % np]);
            let best = -1, bestD = Infinity;
            analysis.gutter_runs.forEach((r, ri) => {
              const rm = mid(r.start, r.end);
              const d = Math.hypot(rm.x - em.x, rm.y - em.y);
              if (d < bestD) { bestD = d; best = ri; }
            });
            if (best >= 0 && bestD <= cap) {
              const r = analysis.gutter_runs[best];
              analysis.gutter_runs.splice(best, 1);
              analysis.excluded_edges = [
                ...(analysis.excluded_edges ?? []),
                { kind: "rake", start: r.start, end: r.end, reason: "Gable end marked on the A9 roof-framing sheet" },
              ];
              gableMarks++;
            }
          }
          // Re-anchor the scale to the printed overall dimension (see the A4
          // block below for the rationale) so the point-space outline prices at
          // true feet instead of the AI's inconsistent raster-pixel scale.
          const vscale = deriveVectorScale(poly, scaleAnchorText);
          if (vscale) {
            analysis.scale = { unit: "pixels", feet_per_unit: vscale.ftPerPt, source: vscale.source };
            analysis.gutter_runs = analysis.gutter_runs.map((r) => ({
              ...r,
              length_ft:
                r.length_px != null && Number.isFinite(r.length_px)
                  ? Math.round(r.length_px * vscale.ftPerPt * 10) / 10
                  : r.length_ft,
            }));
          }
          analysis.notes = [
            ...(analysis.notes ?? []),
            `Roof read from the A9 roof-framing sheet (single coordinate space, ${poly.length} corners)` +
              (gableMarks ? `; ${gableMarks} gable end(s) marked from GABLE labels.` : ".") +
              (vscale ? ` Scale re-anchored to ${vscale.ptPerFt} pt/ft.` : ""),
          ];
          footprintSource = `A9 roof vector (${poly.length} corners)`;
          vecTrace.push(`✓ USED A9 roof outline (${poly.length} corners)`);
          roofApplied = true;
        }
      }
    }
  } catch {
    // any failure → fall through to the A4 footprint-copy block unchanged
  }

  // COPY the building outline from the PDF's vector layer (the drawn walls on
  // the foundation/floor plan) instead of using the AI's reconstructed
  // footprint, which flattens to a box. The segments were already extracted at
  // analysis time (_vectorGeometry.footprint). When we recover a believable
  // outline, it BECOMES the footprint + the eave runs (geometry from the
  // drawing); the AI's runs only lend their tier/feature labels. Fully
  // fail-safe: any miss leaves the AI geometry untouched. SKIPPED when the A9
  // single-sheet read above already produced a roof.
  if (!edgeApplied && !roofApplied) try {
    const aj = row.analysisJson as {
      _vectorGeometry?: { footprint?: { segments?: number[][] } };
    } | null;
    const segs = aj?._vectorGeometry?.footprint?.segments;
    vecTrace.push(Array.isArray(segs) && segs.length >= 4 ? `A4 footprint: ${segs.length} vector segs` : "A4 footprint: no vector segments");
    if (Array.isArray(segs) && segs.length >= 4) {
      const outline = extractBuildingOutline(segs);
      vecTrace.push(
        !outline
          ? "A4 extract → null (segments didn't enclose a building)"
          : outline.polygon.length <= 4
            ? `A4 outline ${outline.polygon.length} corners — a plain box, skipped (adds no articulation over the AI trace)`
            : outline.polygon.length > 60
              ? `A4 outline ${outline.polygon.length} corners — too noisy, skipped`
              : `A4 outline ${outline.polygon.length} corners`,
      );
      // Only copy the outline when it actually adds ARTICULATION (a real jog /
      // wing — more than a plain rectangle). A 4-corner box is no better than
      // the AI's footprint and copying it would only risk dropping the AI's
      // eave/gable read. CRUCIALLY we keep the AI's eave-vs-gable + tier
      // classification — we align it onto the copied outline (per-axis), not
      // flatten everything to eaves (which forced a wrong HIP roof before).
      if (outline && outline.polygon.length > 4 && outline.polygon.length <= 60 && !polygonCloses(outline.polygon)) {
        vecTrace.push("A4 outline self-intersects — skipped");
      } else if (outline && outline.polygon.length > 4 && outline.polygon.length <= 60) {
        const poly = outline.polygon;
        const pbb = outline.bbox;
        const aiPts = [
          ...analysis.gutter_runs.flatMap((r) => [r.start, r.end]),
          ...(analysis.excluded_edges ?? []).flatMap((e) => [e.start, e.end]),
        ].filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
        if (aiPts.length >= 2) {
          let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
          for (const p of aiPts) {
            ax0 = Math.min(ax0, p.x); ay0 = Math.min(ay0, p.y);
            ax1 = Math.max(ax1, p.x); ay1 = Math.max(ay1, p.y);
          }
          const sx = (pbb.x1 - pbb.x0) / Math.max(1e-6, ax1 - ax0);
          const sy = (pbb.y1 - pbb.y0) / Math.max(1e-6, ay1 - ay0);
          // Map AI geometry onto the outline's bbox so eaves land on the real
          // edges (the skeleton classifies each side from where eaves sit).
          const T = (p: { x: number; y: number }) => ({
            x: pbb.x0 + (p.x - ax0) * sx,
            y: pbb.y0 + (p.y - ay0) * sy,
          });
          analysis.building_footprint = poly.map((p) => ({ x: p.x, y: p.y }));
          analysis.gutter_runs = analysis.gutter_runs.map((r) => ({
            ...r,
            start: T(r.start),
            end: T(r.end),
            length_px: Math.hypot(T(r.end).x - T(r.start).x, T(r.end).y - T(r.start).y),
          }));
          analysis.excluded_edges = (analysis.excluded_edges ?? []).map((e) => ({
            ...e,
            start: T(e.start),
            end: T(e.end),
          }));
          analysis.downspouts = (analysis.downspouts ?? []).map((d) => ({
            ...d,
            at: T(d.at),
          }));
          // Reprice the coordinate space: the runs now sit in the outline's own
          // PDF-point space, but their length_ft (and analysis.scale) were
          // calibrated on the AI's RASTER-pixel trace — a different, and on a
          // mis-traced plan wildly inconsistent, scale (Woodinville: footprint
          // px say 0.035 ft/px, runs say 0.099, 2.9× apart). Anchor to the
          // printed overall dimension the model echoed in scale.source, snap to
          // the sheet's real drawing scale, and rewrite each run's length_ft
          // from its on-outline length. Fail-safe: no parse → AI scale stands.
          const vscale = deriveVectorScale(poly, scaleAnchorText);
          if (vscale) {
            analysis.scale = { unit: "pixels", feet_per_unit: vscale.ftPerPt, source: vscale.source };
            analysis.gutter_runs = analysis.gutter_runs.map((r) => ({
              ...r,
              length_ft:
                r.length_px != null && Number.isFinite(r.length_px)
                  ? Math.round(r.length_px * vscale.ftPerPt * 10) / 10
                  : r.length_ft,
            }));
          }
          analysis.notes = [
            ...(analysis.notes ?? []),
            `Footprint shape copied from the plan's vector outline (${poly.length} corners); the AI's eave/gable/tier classification kept.` +
              (vscale ? ` Scale re-anchored to ${vscale.ptPerFt} pt/ft from the printed overall dimension.` : ""),
          ];
          footprintSource = `A4 foundation vector (${poly.length} corners)`;
          vecTrace.push(`✓ USED A4 footprint outline (${poly.length} corners)${vscale ? `, scale ${vscale.ptPerFt} pt/ft` : ""}`);
        } else {
          vecTrace.push("A4 skipped — AI trace has <2 points to map the outline onto");
        }
      }
    }
  } catch (e) {
    vecTrace.push(`vector swap threw: ${e instanceof Error ? e.message : String(e)}`);
    // keep the AI geometry on any failure
  }

  // SQUARE UP the raw-vision footprint. On a scanned/flattened PDF none of the
  // vector swaps above can fire, so the footprint is a pure VISION trace — which
  // comes back nearly rectilinear but with a wall or two a few degrees off,
  // rendering as a "totally wrong" diagonal eave (and the runs + downspouts,
  // traced in the same space, inherit the skew). This squares the outline onto
  // true H/V walls and carries the gutter runs, excluded edges and downspouts
  // onto the cleaned perimeter. It only ever CLEANS (hard-gated: bails on a
  // genuinely diagonal roof or any real area/corner drift) and it does NOT
  // touch length_ft — the priced eave LF is unchanged, only the geometry is
  // straightened. STRICTLY the AI-trace fallback: a vector-derived outline is
  // already clean and must not be re-squared.
  if (
    footprintSource === "AI trace (best-of read)" &&
    Array.isArray(analysis.building_footprint) &&
    analysis.building_footprint.length >= 4
  ) {
    try {
      const runs = analysis.gutter_runs ?? [];
      const exEdges = analysis.excluded_edges ?? [];
      const dss = analysis.downspouts ?? [];
      // Flatten every point traced in the footprint's space, in a fixed order.
      const followers: { x: number; y: number }[] = [];
      for (const r of runs) followers.push(r.start, r.end);
      for (const e of exEdges) followers.push(e.start, e.end);
      for (const d of dss) followers.push(d.at);
      const sq = rectifyPlanFootprint(analysis.building_footprint, followers);
      if (sq.applied) {
        analysis.building_footprint = sq.footprint;
        let k = 0;
        analysis.gutter_runs = runs.map((r) => {
          const start = sq.followers[k++];
          const end = sq.followers[k++];
          // Recompute the PIXEL length to match the moved endpoints; leave
          // length_ft (the priced value) exactly as the AI read it.
          return {
            ...r,
            start,
            end,
            length_px: Math.hypot(end.x - start.x, end.y - start.y),
          };
        });
        analysis.excluded_edges = exEdges.map((e) => {
          const start = sq.followers[k++];
          const end = sq.followers[k++];
          return { ...e, start, end };
        });
        analysis.downspouts = dss.map((d) => ({ ...d, at: sq.followers[k++] }));
        const rough = typeof sq.axisFrac === "number" && sq.axisFrac < 0.8;
        analysis.notes = [
          ...(analysis.notes ?? []),
          `📐 Squared the vision footprint onto true horizontal/vertical walls and snapped the gutter runs + downspouts onto the cleaned perimeter (a diagonal eave / a floating downspout on a scanned plan is a trace artifact, not a real roofline). Priced LF unchanged.`,
          ...(rough
            ? [
                `⚠ ROUGH TRACE — the vision read was only ${Math.round((sq.axisFrac ?? 0) * 100)}% axis-aligned before squaring (a clean read is ~95%+). The squared outline passed the area/corner safety gates, but verify the overall shape against the roof plan before quoting.`,
              ]
            : []),
        ];
        vecTrace.push(
          `✓ squared vision footprint (${analysis.building_footprint.length} corners, ${sq.angleDeg.toFixed(1)}° off-axis${rough ? `, ROUGH ${Math.round((sq.axisFrac ?? 0) * 100)}% input` : ""})`,
        );
      } else {
        vecTrace.push(`vision footprint not squared: ${sq.reason}`);
      }
    } catch (e) {
      vecTrace.push(`square threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Surface the whole decision: console for logs + a note so the takeoff panel
  // shows which footprint won and, when it's the AI trace, exactly why the
  // vector outline didn't. This is what turns a silent no-op into a diagnosis.
  console.log(`[vector-swap] footprint = ${footprintSource} | ${vecTrace.join(" | ")}`);
  // When NO sheet yielded vector linework and we fell to the AI vision trace,
  // say so plainly at the TOP. A crisp-looking plan with zero vectors on every
  // page is a scanned or flattened PDF (common on "FOR PRICING PURPOSES ONLY"
  // sets) — the precise engine can't run, the footprint SHAPE is a vision
  // estimate, and the fix is to verify/edit it on the canvas or supply the CAD
  // (vector) PDF. Without this the takeoff just "looks wrong" with no reason.
  const vgAny = (row.analysisJson as { _vectorGeometry?: { roof?: { segments?: unknown[] }; footprint?: { segments?: unknown[] } } } | null)?._vectorGeometry;
  const roofSegN = Array.isArray(vgAny?.roof?.segments) ? vgAny!.roof!.segments!.length : 0;
  const fpSegN = Array.isArray(vgAny?.footprint?.segments) ? vgAny!.footprint!.segments!.length : 0;
  if (
    !edgeApplied &&
    !roofApplied &&
    footprintSource === "AI trace (best-of read)" &&
    roofSegN < 4 &&
    fpSegN < 4
  ) {
    analysis.notes = [
      "⚠ SCANNED / FLATTENED PDF — no sheet in this set has extractable vector linework (common on 'FOR PRICING PURPOSES ONLY' plans, which are exported as images). The precise vector engine can't run, so the footprint SHAPE below is a VISION estimate: the total LF is in range, but verify the outline against the roof plan and refine the jogs/wings on the canvas before quoting. For an exact trace, supply the CAD (vector) PDF.",
      ...(analysis.notes ?? []),
    ];
  }
  analysis.notes = [
    ...(analysis.notes ?? []),
    `🧭 Footprint source: ${footprintSource}. Vector-outline trace: ${vecTrace.join(" → ")}.`,
  ];

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
            elevation_side?: string | null;
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
        // Carry the classifier's per-sheet type + (for elevations) which
        // face it draws, so the Elevations view can show the four real
        // side drawings labelled FRONT/REAR/LEFT/RIGHT. Load-time — no
        // re-analyze needed (rebuilt from the stored classifier output).
        sheetType: s.sheet_type,
        elevationSide: s.elevation_side ?? undefined,
      };
    });
  const pageCount =
    row.pageCount ??
    (sheets.length ? Math.max(...sheets.map((s) => s.pageIndex)) : undefined);

  // Per-face elevation reads + per-mass roof areas (stored by the analysis
  // pipeline) let the engine draw each face's gables + pop-outs by rule (with
  // real projection depth = roof area ÷ span) when the engine flag is on.
  const engineStash = row.analysisJson as
    | {
        _perFace?: { per_face?: Record<string, unknown> };
        _engine?: { roofMasses?: unknown; orientation?: { normals?: unknown } | null };
      }
    | null;
  const perFace = engineStash?._perFace?.per_face ?? null;
  const roofMasses = engineStash?._engine?.roofMasses ?? null;

  // Compass→canvas orientation: the per-face reads' sheet_title echoes are the
  // primary source (the model reads "FRONT/NORTH ELEVATION" even when the title
  // is drawn as glyph outlines); the gates' text-layer derivation is the stored
  // fallback. Null → the legacy north-up assumption (unchanged behavior).
  const titleOrientation = deriveOrientationFromFaceTitles(
    perFace as Record<string, { sheet_title?: string | null }> | null,
  );
  const orientation =
    titleOrientation ??
    ((engineStash?._engine?.orientation ?? null) as import("@/lib/ai/plan-orientation").PlanOrientation | null);
  if (titleOrientation) {
    analysis.notes = [...(analysis.notes ?? []), `🧭 ${titleOrientation.note}`];
  }

  // 📄 ROOF-PLAN PAGE AS LAYOUT TRUTH (owner doctrine): when the set printed
  // a roof framing / roof plan page, its per-side verdicts — hips at every
  // corner, gutter callouts, downspout dots, tier steps — outrank the
  // elevations (the fallback, since not every set has such a page), which in
  // turn outrank the vision trace's own claims. The read is stored by the
  // analysis routes for scanned/raster sets (_roofPlanRead); mergeLayoutEvidence
  // does the priority merge (roof page wins where it read; elevations fill the
  // gaps and keep everything the plan view can't see). Absent or unreadable →
  // perFaceEff === perFace and every consumer below is byte-identical (old
  // stashes have no field at all).
  const roofPlanStash = (
    row.analysisJson as { _roofPlanRead?: { reading?: unknown } | null } | null
  )?._roofPlanRead;
  const roofPlanRead = parseRoofPlanReading(roofPlanStash?.reading ?? null);
  const layoutMerge = mergeLayoutEvidence(
    roofPlanRead,
    perFace as Partial<
      Record<string, import("@/lib/ai/face-merge").FaceReadingRaw>
    > | null,
  );
  const perFaceEff: Record<string, unknown> | null = layoutMerge.usedRoofPlan
    ? (layoutMerge.perFace as unknown as Record<string, unknown>)
    : perFace;
  if (layoutMerge.usedRoofPlan && layoutMerge.notes.length > 0) {
    analysis.notes = [...(analysis.notes ?? []), ...layoutMerge.notes];
  }

  // CROSS-VIEW TIER-CORNER VETO + DEEP-NOTCH AUDIT — scanned/raster path only
  // (the AI-trace fallback; vector-derived outlines don't carve phantom
  // pockets and carry classifier-audited tiers). Runs AFTER the squaring
  // above and BEFORE the perimeter closure below, so the closure never
  // auto-prices a suspect pocket's legs.
  //  - The veto RETIERS a lower porch/patio run that the elevations' new
  //    position/eave_below_main reads place at a different corner (1168G put
  //    the covered-outdoor-living loop on the garage corner). LF-neutral:
  //    geometry, lengths and totals untouched; loud note.
  //  - The notch audit flags deep, narrow pockets the trace carved
  //    (flag-not-carve: the ring is never edited) and hands their legs to
  //    closeVectorPerimeter as excludeEdges so they stay UNPRICED.
  //  - When the pinned lower corner is at the REAR but the traced rear edge
  //    runs straight, an UN-PRICED tap-to-add return is suggested (F4).
  const isAiTrace = footprintSource === "AI trace (best-of read)";
  const notchExcludes: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  const suggestedEavesFromPlan: {
    points: { x: number; y: number }[];
    tier?: import("@/lib/types").EaveTier;
  }[] = [];
  if (isAiTrace) {
    try {
      const veto = tierCornerVeto({
        analysis,
        // Merged layout evidence: the roof-plan page's per-side verdicts win,
        // elevations fill the gaps (synthesized faces carry no projections /
        // eave_steps keys, so they can never invent a pin).
        perFace: perFaceEff as Partial<
          Record<string, import("@/lib/ai/face-merge").FaceReadingRaw>
        > | null,
        faceNormals: orientation?.normals ?? null,
      });
      if (veto.vetoedRunIds.length > 0) {
        analysis.gutter_runs = veto.analysis.gutter_runs;
      }
      if (veto.notes.length > 0) {
        analysis.notes = [...(analysis.notes ?? []), ...veto.notes.map((n) => `⚠ ${n}`)];
      }
      if (veto.suggestedReturn) {
        suggestedEavesFromPlan.push({
          points: [veto.suggestedReturn.start, veto.suggestedReturn.end],
          tier: "lower",
        });
        analysis.notes = [...(analysis.notes ?? []), `⚠ ${veto.suggestedReturn.note}`];
      }
      const suspects = auditNotches(analysis.building_footprint ?? [], null, {
        runs: analysis.gutter_runs,
      });
      for (const s of suspects) {
        notchExcludes.push(...s.edges);
        // "elsewhere" only when the pocket is CLEARLY in a different quadrant
        // than the pinned corner ("rear" overlaps "rear-right" — say nothing).
        const clearlyElsewhere =
          !!veto.pinned &&
          !veto.pinned.corner.includes(s.where) &&
          !s.where.includes(veto.pinned.corner);
        const pinnedClause = clearlyElsewhere
          ? `, and the ${veto.pinned!.faces.join(" + ")} elevations place the covered area elsewhere (at the ${veto.pinned!.corner})`
          : "";
        analysis.notes = [
          ...(analysis.notes ?? []),
          `🕳 DEEP NOTCH ON THE TRACE — the footprint carves an ~${Math.round(s.depthFt)} ft pocket at the ${s.where}, unsupported by the elevations${pinnedClause}. Kept drawn for review; its walls were NOT auto-priced — verify/edit the outline.`,
        ];
      }
      if (veto.vetoedRunIds.length > 0 || veto.notes.length > 0 || suspects.length > 0) {
        console.log(
          `[tier-notch-audit] ${veto.vetoedRunIds.length} run(s) retiered, ${suspects.length} notch suspect(s)` +
            (veto.pinned ? `, lower tier pinned ${veto.pinned.corner}` : "") +
            (veto.suggestedReturn ? ", rear-step return suggested" : ""),
        );
      }
    } catch (e) {
      console.warn(
        `[tier-notch-audit] threw (takeoff unchanged):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ELEVATIONS-FIRST ROOF JOG (owner doctrine: gutters hang on the ROOF edge;
  // jogs come from the roof shape — the eave-line profile on each ELEVATION
  // first, roof plan next, never a wall jog alone). reconcileEaveSteps
  // cross-checks each readable face's eave_steps against the traced
  // footprint's same-face jogs:
  //  - a matched jog gets a "roof-verified" note;
  //  - an eave-line break the trace MISSED becomes an UNPRICED tap-to-add
  //    suggestion (suggest-don't-carve), + the hip inner-return leg under a
  //    hip tier step;
  //  - a traced wall jog under a straight-eave read is flagged loudly (roof
  //    wins) — the run is never deleted or unpriced.
  // Outline-agnostic, so it runs on BOTH trace kinds, AFTER the tier-corner
  // veto and BEFORE the perimeter closure. Notes/suggestions only: geometry
  // and priced LF are byte-untouched, and old stored reads (no eave_steps
  // key anywhere) pass through byte-identical.
  try {
    const stepRec = reconcileEaveSteps({
      analysis,
      // Merged layout evidence (roof page > elevations). Synthesized roof-page
      // faces deliberately carry NO eave_steps key ("not read"), so a set with
      // no readable elevation eave-steps still degrades byte-identical.
      perFace: perFaceEff as Partial<
        Record<string, import("@/lib/ai/face-merge").FaceReadingRaw>
      > | null,
      faceNormals: orientation?.normals ?? null,
    });
    const stepNotes = [...stepRec.notes, ...stepRec.wallJogFlags];
    if (stepNotes.length > 0) {
      analysis.notes = [...(analysis.notes ?? []), ...stepNotes.map((n) => `⚠ ${n}`)];
    }
    for (const s of stepRec.suggestedEaves) {
      suggestedEavesFromPlan.push({ points: [s.points[0], s.points[1]], tier: s.tier });
    }
    if (stepNotes.length > 0 || stepRec.suggestedEaves.length > 0) {
      console.log(
        `[eave-step-reconcile] ${stepRec.verifiedJogIds.length} jog(s) roof-verified, ` +
          `${stepRec.suggestedEaves.length} unpriced suggestion(s), ` +
          `${stepRec.wallJogFlags.length} wall-jog flag(s)`,
      );
    }
  } catch (e) {
    console.warn(
      `[eave-step-reconcile] threw (takeoff unchanged):`,
      e instanceof Error ? e.message : e,
    );
  }

  // VECTOR CLOSURE — only when the footprint is the plan's own vector outline
  // (the swap above applied). Every outline edge is then real CAD linework, so
  // an exterior edge with no gutter/rake classification is a silently-missed
  // eave (Woodinville priced 189 LF of a ~240 LF perimeter). Prices those
  // edges as eaves at the runs' own cross-validated scale, honoring gable-end
  // face reads; loud note for review.
  // HIP EXCEPTION for AI-trace (raster) footprints: normally they keep the
  // strict symmetric-twin-only reconcile from analysis time, because an
  // unclassified wall on a freehand ring might be an unmarked gable rake. But
  // when every readable elevation reads a continuous eave with ZERO gables
  // (isUnanimousHip — the 1168G BIDSET: all 4 faces hip, yet 7 walls / ~30 LF
  // sat unpriced), that ambiguity is gone: a hip roof carries an eave on every
  // exterior wall. Trace mode is additionally capped at the ring's own
  // perimeter inside closeVectorPerimeter.
  // Closure is a v1 repair for freehand runs that under-cover the vector
  // outline. The v2 edge takeoff covers every edge explicitly (unknowns are
  // flagged UNPRICED on purpose) — running closure would re-introduce the
  // blind "continuous gutters" default it exists to remove. Skip it.
  // (isAiTrace hoisted above the tier/notch audit.)
  // 📄 The roof-plan page can establish unanimous hip BY ITSELF: readable,
  // hips at every corner, a continuous eave on all four sides, no gable end.
  // This is the 529-outage fix — on the 1168G scan two elevation reads died
  // transiently, unanimity couldn't form, and the trace's hallucinated "gable
  // ends left and right" unpriced both long walls while page 6 printed the
  // full hip layout. When the page doesn't decide it, the merged evidence
  // (roof page filled + elevations) gets the same vote it always had.
  const roofPlanHip = roofPlanUnanimousHip(roofPlanRead);
  const hipVerdict = roofPlanHip
    ? { unanimous: true as const, reason: null }
    : explainUnanimousHip(
        perFaceEff as Partial<Record<string, import("@/lib/ai/face-merge").FaceReadingRaw>> | null,
      );
  if (roofPlanHip && isAiTrace) {
    const elevAlone = explainUnanimousHip(
      perFace as Partial<Record<string, import("@/lib/ai/face-merge").FaceReadingRaw>> | null,
    );
    analysis.notes = [
      ...(analysis.notes ?? []),
      `📄 Roof-plan page: hips at every corner, a continuous eave on all four sides, no gable ends — used as the layout source (${
        elevAlone.unanimous
          ? "agrees with the elevations"
          : `elevations degraded: ${elevAlone.reason}`
      }). Every exterior wall carries a gutter eave.`,
    ];
  }
  const hipClosureOk = isAiTrace && hipVerdict.unanimous;
  // A skipped closure must say WHY on the panel: the contractor is looking at
  // a "Closure check: N walls not priced" flag and deserves the reason the
  // hip exception didn't clear it (only 2 readable faces? a face read a
  // gable?) instead of a silent no-op.
  if (
    !edgeApplied &&
    isAiTrace &&
    !hipVerdict.unanimous &&
    (analysis.notes ?? []).some(
      (n) => typeof n === "string" && n.includes("Closure check:"),
    )
  ) {
    analysis.notes = [
      ...(analysis.notes ?? []),
      `⏸ Hip closure not applied — ${hipVerdict.reason}. The unpriced walls above stay review-flagged; if this roof is actually fully hipped, Re-analyze so fresh elevation reads can prove it.`,
    ];
  }
  if (!edgeApplied && (!isAiTrace || hipClosureOk)) {
    const closed = closeVectorPerimeter(analysis, {
      faceNormals: orientation?.normals ?? null,
      // Merged layout evidence: a roof-page face reading a continuous eave
      // with zero gables qualifies for the closure's ELEVATION-EAVE-WINS
      // restoration — the trace's hallucinated rakes on a hip side get their
      // gutters back even when that side's elevation read died.
      perFace: perFaceEff as Record<string, { readable?: boolean; continuous_eave?: boolean }> | null,
      mode: isAiTrace ? "trace-hip" : "vector",
      // Deep-notch audit suspects: closure must never bill a carved pocket's
      // legs as eaves (counted + noted UNPRICED inside). Empty → unchanged.
      excludeEdges: notchExcludes.length > 0 ? notchExcludes : undefined,
    });
    if (closed.reconcileNotes.length > 0) {
      analysis.gutter_runs = closed.analysis.gutter_runs;
      analysis.totals = closed.analysis.totals;
      analysis.notes = [...(analysis.notes ?? []), ...closed.reconcileNotes.map((n) => `➕ ${n}`)];
    }
    // Cap-blocked uncovered wall spans: the closure refused to auto-price
    // them (the runs already exceed the ring's own perimeter — a hot scale
    // read), but they're real unguttered geometry — surface each as an
    // unpriced tap-to-add suggestion on the canvas.
    for (const s of closed.suggestedRuns ?? []) {
      suggestedEavesFromPlan.push({ points: [s.start, s.end], tier: "upper" });
    }
  }

  // 💧 Printed downspout marks on the roof-plan page are a FLOOR for the
  // takeoff's downspout count (printed marks beat the 1-per-40 ft rule —
  // same doctrine as the elevations' min-downspouts constraint). Note-only:
  // positions aren't read off the page, so nothing is fabricated; the owner
  // tap-adds the missing drops on the canvas.
  if (roofPlanRead) {
    const dsFloor = roofPlanDsFloor(roofPlanRead, (analysis.downspouts ?? []).length);
    if (dsFloor) {
      analysis.notes = [...(analysis.notes ?? []), dsFloor.note];
    }
  }

  const result = blueprintToEstimateResult(
    analysis,
    {
      filename: row.filename,
      durationMs: row.durationMs ?? undefined,
      planId: row.id,
      pageCount,
      sheets,
    },
    {
      // v2 edge takeoff: the classifier's exact per-edge runs ARE the drawn
      // geometry, and the layout skeleton is the drawn interior. The guess
      // engine (elevation-placed gables, per-mass skeletons, mass-edge eave
      // rebuild) would overwrite both — keep it off on this path.
      useEngineTakeoff: engineTakeoffEnabled() && !edgeApplied,
      useEngineDraw: engineDrawEnabled() && !edgeApplied,
      perimeterOnly: perimeterOnlyEnabled(),
      perFace: perFace as Record<string, import("@/lib/ai/face-merge").FaceReadingRaw> | null,
      roofMasses: roofMasses as import("@/lib/ai/to-masses").RoofMassArea[] | null,
      droppedProjections,
      faceNormals: orientation?.normals ?? null,
      // UN-PRICED tap-to-add suggestions from the tier-corner veto (the rear
      // tier-step return) — projected into canvas space by the assembler,
      // never summed into eaveLF.
      suggestedEaves: suggestedEavesFromPlan.length > 0 ? suggestedEavesFromPlan : null,
      edgeLayout: edgeApplied && edgeLayout?.ok
        ? {
            ridges: edgeLayout.ridges,
            valleys: edgeLayout.valleys,
            hips: edgeLayout.hips,
            gableCount: edgeLayout.gableCount,
            // Stored stashes predate these fields — guard the array shapes
            // like the ridges/valleys check above so old JSON degrades clean.
            gableEnds: Array.isArray(edgeLayout.gableEnds)
              ? edgeLayout.gableEnds
              : [],
            faces: Array.isArray(edgeLayout.faces) ? edgeLayout.faces : null,
            confidence: edgeLayout.confidence,
          }
        : null,
    },
  );

  // Same admin-only rule as the address path: the analysis log is an
  // internal diagnostic, not part of the contractor's deliverable.
  if (!isAdmin) result.notes = [];

  return {
    ok: true,
    result,
    reused: true, // not chargeable; surface as "reused" in the UI badge
    remaining,
    runId: row.id,
  };
}
