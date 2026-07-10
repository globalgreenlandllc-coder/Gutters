"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runAIEstimatePipeline, type EstimateResult } from "@/lib/ai";
import { blueprintToEstimateResult } from "@/lib/ai/blueprint-to-estimate";
import { engineDrawEnabled, engineTakeoffEnabled, perimeterOnlyEnabled } from "@/lib/ai/engine-takeoff";
import type { BlueprintAnalysis } from "@/lib/ai/blueprint-from-plans";
import { extractBuildingOutline, deriveVectorScale } from "@/lib/ai/outline-from-vectors";
import { humanizeAiError } from "@/lib/ai/humanize-error";
import { readRoofFromVectors } from "@/lib/ai/roof-from-vectors";
import { deriveOrientationFromFaceTitles } from "@/lib/ai/plan-orientation";
import { closeVectorPerimeter } from "@/lib/ai/reconcile-eaves";
import { polygonCloses } from "@/lib/roof-engine";
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
  try {
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
  if (!roofApplied) try {
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
  // Surface the whole decision: console for logs + a note so the takeoff panel
  // shows which footprint won and, when it's the AI trace, exactly why the
  // vector outline didn't. This is what turns a silent no-op into a diagnosis.
  console.log(`[vector-swap] footprint = ${footprintSource} | ${vecTrace.join(" | ")}`);
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

  // VECTOR CLOSURE — only when the footprint is the plan's own vector outline
  // (the swap above applied). Every outline edge is then real CAD linework, so
  // an exterior edge with no gutter/rake classification is a silently-missed
  // eave (Woodinville priced 189 LF of a ~240 LF perimeter). Prices those
  // edges as eaves at the runs' own cross-validated scale, honoring gable-end
  // face reads; loud note for review. AI-trace footprints keep the strict
  // symmetric-twin-only reconcile from analysis time.
  if (footprintSource !== "AI trace (best-of read)") {
    const closed = closeVectorPerimeter(analysis, {
      faceNormals: orientation?.normals ?? null,
      perFace: perFace as Record<string, { readable?: boolean; continuous_eave?: boolean }> | null,
    });
    if (closed.reconcileNotes.length > 0) {
      analysis.gutter_runs = closed.analysis.gutter_runs;
      analysis.totals = closed.analysis.totals;
      analysis.notes = [...(analysis.notes ?? []), ...closed.reconcileNotes.map((n) => `➕ ${n}`)];
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
      useEngineTakeoff: engineTakeoffEnabled(),
      useEngineDraw: engineDrawEnabled(),
      perimeterOnly: perimeterOnlyEnabled(),
      perFace: perFace as Record<string, import("@/lib/ai/face-merge").FaceReadingRaw> | null,
      roofMasses: roofMasses as import("@/lib/ai/to-masses").RoofMassArea[] | null,
      faceNormals: orientation?.normals ?? null,
    },
  );

  return {
    ok: true,
    result,
    reused: true, // not chargeable; surface as "reused" in the UI badge
    remaining,
    runId: row.id,
  };
}
