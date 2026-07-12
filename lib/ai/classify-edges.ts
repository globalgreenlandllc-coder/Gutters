import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { getActiveApiKey } from "@/lib/api-keys";
import type { PlanSource } from "./blueprint-from-plans";
import {
  renderEdgeMapSvg,
  renderDimMapSvg,
  outlineEdges,
  type OverlayPt,
  type OutlineEdge,
} from "./plan-overlay";
import { findDimSpanCandidates, solvePtPerFt } from "./dim-scale";
import { extractBuildingOutline } from "./outline-from-vectors";
import type { EdgeClass, EdgeDownspout } from "./edge-takeoff";
import { buildRoofLayout, type RoofLayout } from "./roof-layout";
import { reconcileEdgeClasses, type DroppedProjection } from "./reconcile-edge-classes";
import { applyTrussFieldDemotions, deriveTrussField } from "./truss-field";
import type { FaceReadingRaw } from "./face-merge";

/**
 * classify-edges.ts — the ONE expensive vision call of the v2 takeoff.
 *
 * "Classify, don't trace": geometry is the plan's own vector outline (exact,
 * deterministic); the model answers multiple-choice questions about edges WE
 * number (E1…En on an annotated overlay) and reads printed dimension values
 * for spans WE measured (D1…Dk). It never outputs a coordinate, so it cannot
 * corrupt geometry — and an edge with no evidence stays "unknown" and is
 * NEVER priced (no blind "continuous gutters" default).
 *
 * Cost stance is owner-approved: default model is the strongest vision model
 * (override with BLUEPRINT_EDGE_MODEL), one call per analysis.
 */

const MODEL = process.env.BLUEPRINT_EDGE_MODEL || "claude-opus-4-8";

/** Kill switch: any value but "0" leaves the edge takeoff ON. */
export function edgeTakeoffEnabled(): boolean {
  return process.env.BLUEPRINT_EDGE_TAKEOFF !== "0";
}

export type EdgeClassification = {
  ok: boolean;
  reason?: string;
  /** The exact outline the edges were numbered on — the estimate path MUST
   *  use this polygon so ids stay aligned. */
  outline: OverlayPt[];
  classes: EdgeClass[];
  downspouts: EdgeDownspout[];
  /** Solved from dimension lines (vector span ÷ vision-read printed value). */
  ptPerFt: number | null;
  scaleSource: string | null;
  dimReads: { id: string; feet: number | null; text: string | null }[];
  ridgeHints: { direction: "ns" | "ew"; near_edge_id: string }[];
  tierNote: string | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  notes: string[];
  /** Deterministic ridge/hip/valley layout computed from the classified
   *  perimeter (straight skeleton, rakes as stationary gable walls) and
   *  evidence-checked against the roof sheet's own 45° linework. */
  layout?: RoofLayout | null;
  /** Projecting masses (open porch/patio/garage on posts/beam) whose own
   *  gutters sit beyond the traced outline — the estimate assembler turns
   *  these into ESTIMATED gutter lines from the roof-area schedule so the LF
   *  isn't silently dropped. Empty on every path but the elevation-reconcile. */
  droppedProjections?: DroppedProjection[];
};

const EDGE_SYSTEM = `
You are a senior rain-gutter estimator. You are given (1) an EDGE MAP — the
exact roof outline extracted from the plan's own vector linework, every edge
tagged E1…En, candidate dimension spans tagged D1…Dk — and (2) the original
construction plan set (all sheets: roof framing plan, floor plans, elevations).

Your job is CLASSIFICATION ONLY. The geometry is already exact — never
re-measure or re-draw it. For every E-chip edge decide:

  eave — a horizontal roof edge that takes a continuous gutter
  rake — a gable-end / sloped edge that takes NO gutter
  unknown — you found no evidence either way (this is a VALID answer)

<evidence>
Work from the DRAWINGS' OWN WORDS and construction logic, strongest first:
- "GABLE END TRUSS" / "STRUCT. GABLE END TRUSS" printed along a wall on the
  roof-framing plan ⇒ that edge is a RAKE (tag: gable_end_truss_label).
- "LINE OF CONTINUOUS METAL GUTTER" / "CONT. METAL GUTTER" / "LINE OF FASCIA
  BOARD" leader pointing at an edge ⇒ EAVE (tag: gutter_callout /
  fascia_callout).
- "BARGE BOARD @ GABLE ENDS & RAKES" or a rake/overhang note ("6" O.H. RAKE")
  pointing at an edge ⇒ RAKE (tag: barge_or_rake_callout).
- TRUSS DIRECTION on the framing plan: truss lines drawn PERPENDICULAR to an
  edge bear ON it ⇒ that edge is an EAVE. Truss lines PARALLEL to an edge,
  arrayed toward it, end at a gable-end ⇒ RAKE (tag: truss_direction).
  ⚠ TRUSS DIRECTION IS PER-MASS, NEVER GLOBAL: a real house has several roof
  masses (main body, garage, porch, patio) and EACH has its own truss array,
  often rotated 90° from its neighbor. Judge every edge ONLY from the trusses
  in the mass that touches THAT edge. Applying one direction to the whole
  outline inverts half the perimeter — the exact failure this warning exists
  to prevent.
- FLOOR-PLAN SLOPE ARROWS ("9:12 SLOPE" with an arrow) point DOWNHILL toward
  the eave; the walls the arrows point AT are eaves, the walls parallel to
  the arrows are rakes (tag: slope_arrow).
- THE ELEVATIONS ARE THE GABLE BUDGET: count the gable triangles on each of
  the four elevation faces first. A side whose elevation shows one continuous
  fascia/gutter line and N gable(s) has AT MOST N rake edges — never call
  more. If the framing sheet seems to disagree with a clearly drawn
  elevation, prefer the elevation and tag the edge unknown.
- The UPPER FLOOR PLAN (when present) is the cleanest footprint sheet: its
  exterior walls are the upper-roof eave walls and its "LINE OF ROOF BELOW"
  dashes show where lower porch/patio/garage roofs attach (lower tier).
- ELEVATIONS: match each elevation face to the edges facing that compass
  direction. A horizontal fascia/gutter line across a wall ⇒ EAVE
  (tag: elevation_eave). A triangular gable face on that wall ⇒ the edge
  under the triangle is a RAKE (tag: elevation_gable).
Cross-check: an edge with a gable-end truss label must NOT be an eave, no
matter what a default says. When two sources conflict, report "unknown" —
do not pick a side.
</evidence>

<tiers_and_features>
tier "lower" = single-story roof section (covered porch, patio, garage eave at
a lower plate height — elevations show it stepping down); tier "upper" =
2-story main body. feature = porch | patio | garage | null, from the floor
plan / elevation labels (COV'D ENTRY, REAR COV'D PATIO, GARAGE).
</tiers_and_features>

<downspouts>
The roof/floor plans mark downspouts as "D.S." at the roof edge; elevations
draw "LINE OF DOWNSPOUT". Map EVERY mark to its edge id and its position
along that edge as a fraction 0..1 measured from endpoint A (the edge table
in the user message says which end is A). Only report marks you can see.
</downspouts>

<dimensions>
Each D-chip is a dashed magenta span on the EDGE MAP whose exact pt length we
measured. Find the SAME dimension line on the original sheet and read its
printed value (e.g. 64'-0" ⇒ 64.0). Report feet as a decimal number, or null
if you cannot read it confidently. NEVER infer a value from a scale note —
read the printed string only.
</dimensions>

<ridge_hints>
From the framing plan's truss directions and RIDGE labels, report the ridge
direction of each roof block as "ns" (ridge runs top-bottom on the sheet) or
"ew" (left-right), naming one edge id belonging to that block.
</ridge_hints>

Call record_edge_classification exactly once. "unknown" beats a guess: a
wrong "eave" bills gutter across a gable; "unknown" gets human review.
`.trim();

function buildTool(edgeIds: string[], dimIds: string[]): Anthropic.Tool {
  return {
    name: "record_edge_classification",
    description: "Record the per-edge classification of the roof outline.",
    input_schema: {
      type: "object",
      properties: {
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", enum: edgeIds },
              edge_class: { type: "string", enum: ["eave", "rake", "unknown"] },
              tier: { type: ["string", "null"], enum: ["upper", "lower", null] },
              feature: {
                type: ["string", "null"],
                enum: ["porch", "patio", "garage", null],
              },
              evidence: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "gable_end_truss_label",
                    "gutter_callout",
                    "fascia_callout",
                    "barge_or_rake_callout",
                    "truss_direction",
                    "elevation_eave",
                    "elevation_gable",
                    "ds_label",
                    "floor_plan_label",
                    "other",
                  ],
                },
              },
            },
            required: ["id", "edge_class", "evidence"],
          },
        },
        downspouts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              edge_id: { type: "string", enum: edgeIds },
              frac: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["edge_id", "frac"],
          },
        },
        dims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", enum: dimIds.length ? dimIds : ["D0"] },
              feet: { type: ["number", "null"] },
              text: {
                type: ["string", "null"],
                description: 'The printed string as drawn, e.g. "64\'-0"".',
              },
            },
            required: ["id", "feet"],
          },
        },
        ridge_hints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              direction: { type: "string", enum: ["ns", "ew"] },
              near_edge_id: { type: "string", enum: edgeIds },
            },
            required: ["direction", "near_edge_id"],
          },
        },
        tier_note: { type: ["string", "null"] },
      },
      required: ["edges", "downspouts", "dims"],
    },
  };
}

/** Human-readable edge table so the model can anchor A/B endpoints and
 *  cross-reference chips against the sheet. */
function edgeTable(edges: OutlineEdge[]): string {
  return edges
    .filter((e) => e.lenPt >= 1e-6)
    .map((e) => {
      const dir =
        e.axis === "h"
          ? `horizontal (A=left end at x${Math.round(e.p1.x < e.p2.x ? e.p1.x : e.p2.x)}, B=right end)`
          : e.axis === "v"
            ? `vertical (A=top end, B=bottom end)`
            : `diagonal (A=first endpoint)`;
      return `${e.id}: ${dir}, ${Math.round(e.lenPt)} pt long`;
    })
    .join("\n");
}

function sourceBlock(source: PlanSource): Anthropic.ContentBlockParam {
  if (source.kind === "pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: source.base64 },
    };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: (source as { mediaType?: string }).mediaType ?? "image/png",
      data: (source as { base64: string }).base64,
    } as Anthropic.Base64ImageSource,
  };
}

/**
 * A protruding stub (porch/patio — both ring neighbors step back inward)
 * carries ONE roof, so its three edges share one tier. The classifier often
 * tags only the outer edge "lower"; spread it to the returns so downspout
 * drop heights price consistently.
 */
function unifyStubTiers(
  edges: readonly OutlineEdge[],
  classes: EdgeClass[],
  outline: readonly OverlayPt[],
): void {
  const n = edges.length;
  if (n < 4 || outline.length < 3) return;
  const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
  const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length;
  const byId = new Map(classes.map((c) => [c.id, c]));
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    const prev = edges[(i - 1 + n) % n];
    const next = edges[(i + 1) % n];
    const dx = e.p2.x - e.p1.x;
    const dy = e.p2.y - e.p1.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if ((cx - e.mid.x) * nx + (cy - e.mid.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const depth = (p: OverlayPt) =>
      (p.x - e.mid.x) * nx + (p.y - e.mid.y) * ny;
    const minStep = Math.max(8, len * 0.15);
    if (depth(prev.p1) <= minStep || depth(next.p2) <= minStep) continue;
    const trio = [byId.get(prev.id), byId.get(e.id), byId.get(next.id)].filter(
      (c): c is EdgeClass => !!c,
    );
    if (trio.some((c) => c.tier === "lower")) {
      for (const c of trio) c.tier = "lower";
    }
  }
}

/**
 * Run the edge classification. Never throws — {ok:false, reason} on any
 * failure so the caller falls back to the v1 path.
 */
export async function classifyPerimeterEdges(opts: {
  source: PlanSource;
  outline: OverlayPt[];
  /** The roof page's extracted linework — context for the overlay. */
  segments?: number[][];
  /** Roof page size in pt — lets the dim search reject the sheet frame. */
  roofPageSize?: { widthPt?: number; heightPt?: number } | null;
  /** The foundation/floor-plan page: overall dimension chains usually live
   *  HERE, not on the roof sheet. Both pages print at one scale, so a value
   *  read on this page solves pt/ft for the roof outline too. */
  footprint?: {
    segments?: number[][];
    widthPt?: number;
    heightPt?: number;
  } | null;
  /** Independent per-face elevation reads — the binding gable budget. Every
   *  rake call is reconciled against the elevation its wall faces; elevation
   *  gables are mapped back onto their wall segments (promote/demote/unknown,
   *  see reconcile-edge-classes.ts). */
  perFace?: Partial<Record<string, FaceReadingRaw>> | null;
  /** Thin-inclusive axis-aligned framing linework (selectFieldSegments) —
   *  lets the truss-field arbiter read eave/gable straight off the sheet's
   *  own truss arrays (truss-field.ts). */
  fieldSegments?: number[][] | null;
}): Promise<EdgeClassification> {
  const empty = (reason: string): EdgeClassification => ({
    ok: false,
    reason,
    outline: opts.outline,
    classes: [],
    downspouts: [],
    ptPerFt: null,
    scaleSource: null,
    dimReads: [],
    ridgeHints: [],
    tierNote: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    model: MODEL,
    notes: [],
    layout: null,
  });

  try {
    if (!opts.outline || opts.outline.length < 3) return empty("no outline");
    const apiKey =
      (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
    if (!apiKey) return empty("no Anthropic API key");

    const edges = outlineEdges(opts.outline);
    const roofDims = findDimSpanCandidates(opts.segments ?? [], opts.outline, 4, {
      pageW: opts.roofPageSize?.widthPt,
      pageH: opts.roofPageSize?.heightPt,
    });
    const { svg } = renderEdgeMapSvg({
      outline: opts.outline,
      segments: opts.segments,
      dims: roofDims,
    });
    const png = await sharp(Buffer.from(svg)).png().toBuffer();

    // Foundation/floor-plan dimension chains — its own outline bounds the
    // "outside the building" band; ids continue after the roof page's.
    let fpDims: ReturnType<typeof findDimSpanCandidates> = [];
    let fpPng: Buffer | null = null;
    const fpSegs = opts.footprint?.segments;
    if (Array.isArray(fpSegs) && fpSegs.length >= 4) {
      try {
        const fpOutline = extractBuildingOutline(fpSegs)?.polygon ?? null;
        if (fpOutline && fpOutline.length >= 3) {
          fpDims = findDimSpanCandidates(fpSegs, fpOutline, 4, {
            pageW: opts.footprint?.widthPt,
            pageH: opts.footprint?.heightPt,
            idOffset: roofDims.length,
          });
          if (fpDims.length > 0) {
            const dm = renderDimMapSvg({
              segments: fpSegs,
              dims: fpDims,
              title:
                "DIMENSION MAP (foundation/floor plan) — read the printed value for each D-chip span",
            });
            fpPng = await sharp(Buffer.from(dm.svg)).png().toBuffer();
          }
        }
      } catch {
        // dim mining on the footprint page is best-effort
      }
    }
    const dims = [...roofDims, ...fpDims];

    const edgeIds = edges.filter((e) => e.lenPt >= 1e-6).map((e) => e.id);
    const dimIds = dims.map((d) => d.id);

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      // Sized for many-edge outlines: a 20+ gable plan can put 60+ E-chips on
      // the ring, each needing a class + evidence entry in the tool JSON.
      max_tokens: 16000,
      // Opus 4.7+/Sonnet 5 reject `temperature` ("deprecated for this model")
      // — this 400 killed the first v2 run. Positive allowlist: pin 0 only on
      // models KNOWN to accept it; unknown/newer models get no sampling params.
      ...(/haiku|sonnet-4-/.test(MODEL) ? { temperature: 0 } : {}),
      system: [{ type: "text", text: EDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `EDGE MAP (first image): the bold ring is the roof outline; classify every E-chip edge; ` +
                `read the printed value for every D-chip dimension from the original sheets.` +
                (fpPng
                  ? ` A second image maps D-chips onto the foundation/floor plan — its printed dimension strings solve the scale (all sheets print at one scale).`
                  : "") +
                `\n\n` +
                `Edge table (endpoint A definitions for downspout fractions):\n${edgeTable(edges)}\n\n` +
                (dimIds.length
                  ? `Dimension spans to read: ${dimIds.join(", ")}.\n\n`
                  : `No dimension spans were detected — report dims: [].\n\n`) +
                `The full plan set follows. Use the roof-framing sheet's own callouts ` +
                `(GABLE END TRUSS, CONT. METAL GUTTER, D.S., truss directions) plus the ` +
                `elevations. Classify each edge, then call record_edge_classification.`,
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: png.toString("base64"),
              },
            },
            ...(fpPng
              ? [
                  {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: "image/png" as const,
                      data: fpPng.toString("base64"),
                    },
                  },
                ]
              : []),
            sourceBlock(opts.source),
          ],
        },
      ],
      tools: [buildTool(edgeIds, dimIds)],
      tool_choice: { type: "tool", name: "record_edge_classification" },
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
    if (!toolUse) return { ...empty("model returned no structured output"), usage };

    const raw = toolUse.input as {
      edges?: unknown;
      downspouts?: unknown;
      dims?: unknown;
      ridge_hints?: unknown;
      tier_note?: unknown;
    };
    const idSet = new Set(edgeIds);

    let classes: EdgeClass[] = (Array.isArray(raw.edges) ? raw.edges : [])
      .filter(
        (e): e is EdgeClass =>
          !!e &&
          typeof (e as EdgeClass).id === "string" &&
          idSet.has((e as EdgeClass).id) &&
          ["eave", "rake", "unknown"].includes((e as EdgeClass).edge_class),
      )
      .map((e) => ({
        id: e.id,
        edge_class: e.edge_class,
        tier: e.tier === "lower" || e.tier === "upper" ? e.tier : null,
        feature: typeof e.feature === "string" ? e.feature : null,
        evidence: Array.isArray(e.evidence) ? e.evidence.map(String) : [],
      }));
    // Edges the model skipped stay unknown — visible, unpriced.
    for (const id of edgeIds) {
      if (!classes.some((c) => c.id === id)) {
        classes.push({ id, edge_class: "unknown", tier: null, feature: null, evidence: [] });
      }
    }

    const downspouts: EdgeDownspout[] = (
      Array.isArray(raw.downspouts) ? raw.downspouts : []
    )
      .filter(
        (d): d is EdgeDownspout =>
          !!d &&
          typeof (d as EdgeDownspout).edge_id === "string" &&
          idSet.has((d as EdgeDownspout).edge_id) &&
          Number.isFinite((d as EdgeDownspout).frac),
      )
      .map((d) => ({ edge_id: d.edge_id, frac: d.frac }));

    const dimReads = (Array.isArray(raw.dims) ? raw.dims : [])
      .filter((d): d is { id: string; feet: number | null; text?: string } =>
        !!d && typeof (d as { id?: unknown }).id === "string",
      )
      .map((d) => ({
        id: d.id,
        feet: Number.isFinite(d.feet as number) ? (d.feet as number) : null,
        text: typeof d.text === "string" ? d.text : null,
      }));
    const solved = solvePtPerFt(dims, dimReads);

    const ridgeHints = (Array.isArray(raw.ridge_hints) ? raw.ridge_hints : [])
      .filter(
        (h): h is { direction: "ns" | "ew"; near_edge_id: string } =>
          !!h &&
          ["ns", "ew"].includes((h as { direction?: string }).direction ?? "") &&
          idSet.has((h as { near_edge_id?: string }).near_edge_id ?? ""),
      )
      .map((h) => ({ direction: h.direction, near_edge_id: h.near_edge_id }));

    // Truss-field arbiter — the framing sheet's own linework, read per edge.
    // A periodic truss array drawn INTO a wall means the wall bears it (eave,
    // enforced here); an array ALONG it is gable-end framing (a rake HINT the
    // elevation reconcile corroborates below). No AI in this step.
    const field = deriveTrussField({
      outline: opts.outline,
      edges,
      segments: opts.fieldSegments ?? null,
      ptPerFt: solved?.ptPerFt ?? null,
    });
    const fieldPass = applyTrussFieldDemotions({ classes, field, edges });
    classes = fieldPass.classes;
    const fieldEave = new Set(
      [...field.entries()]
        .filter(([, v]) => v.verdict === "perpendicular")
        .map(([id]) => id),
    );

    // Elevation reconcile — code-enforced, runs BEFORE the layout so gable
    // ridges land on the walls the elevations actually show gables on. The
    // production failure this guards: one global truss direction inverted
    // eave/rake on half the perimeter (front gables priced, sides tented).
    const reconcile = reconcileEdgeClasses({
      outline: opts.outline,
      edges,
      classes,
      perFace: opts.perFace ?? null,
      ptPerFt: solved?.ptPerFt ?? null,
      fieldParallel: fieldPass.parallelIds,
      fieldEave,
    });
    classes = reconcile.classes;

    // No elevations to corroborate (or none readable) — the sheet's gable-end
    // framing is still better evidence than nothing: promote with a verify
    // note instead of dropping the hint on the floor.
    const anyFaceReadable = ["north", "south", "east", "west"].some(
      (f) => opts.perFace?.[f]?.readable,
    );
    if (!anyFaceReadable) {
      const minRakePt = (solved?.ptPerFt ?? 20) * 8;
      for (const cls of classes) {
        if (!fieldPass.parallelIds.has(cls.id)) continue;
        if (cls.edge_class === "rake") continue;
        const e = edges.find((x) => x.id === cls.id);
        if (!e || e.lenPt < minRakePt) continue;
        cls.edge_class = "rake";
        cls.evidence = [...(cls.evidence ?? []), "truss_field_parallel"];
        fieldPass.notes.push(
          `📐 ${cls.id} → RAKE: gable-end framing runs along this wall on the sheet (no readable elevation to cross-check — verify).`,
        );
      }
    }

    // Protrusion stubs (porch/patio) share one roof — their three edges
    // share one tier. The classifier often tags only the outer edge.
    unifyStubTiers(edges, classes, opts.outline);

    // Interior geometry — computed, never traced. Stored alongside the
    // classes so the estimate path draws the same layout the evidence built.
    const layout = buildRoofLayout({
      outline: opts.outline,
      edges,
      classes,
      segments: opts.segments ?? null,
    });

    const eaves = classes.filter((c) => c.edge_class === "eave").length;
    const rakes = classes.filter((c) => c.edge_class === "rake").length;
    const unknown = classes.filter((c) => c.edge_class === "unknown").length;
    const notes = [
      `🎯 Edge classifier (${MODEL}): ${eaves} eave / ${rakes} rake / ${unknown} unknown of ${edgeIds.length} edges; ` +
        `${downspouts.length} downspout mark(s)` +
        (solved
          ? `; scale ${Math.round(solved.ptPerFt * 100) / 100} pt/ft from dimension line(s) ${solved.used.join(", ")}.`
          : `; no dimension value read — scale unsolved.`),
      ...fieldPass.notes,
      ...reconcile.notes,
      ...layout.notes,
    ];

    return {
      ok: true,
      outline: opts.outline,
      classes,
      downspouts,
      ptPerFt: solved?.ptPerFt ?? null,
      scaleSource: solved
        ? `dimension-line solve (${solved.used.join(", ")})`
        : null,
      dimReads,
      ridgeHints,
      tierNote: typeof raw.tier_note === "string" ? raw.tier_note : null,
      usage,
      model: MODEL,
      notes,
      layout,
      droppedProjections: reconcile.droppedProjections,
    };
  } catch (e) {
    return empty(e instanceof Error ? e.message : "edge classification failed");
  }
}
