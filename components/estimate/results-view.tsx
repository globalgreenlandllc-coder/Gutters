"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Building2,
  Camera,
  PencilRuler,
  RefreshCcw,
  Ruler,
  Sparkles,
} from "lucide-react";
import { TopBar } from "./top-bar";
import { AerialCanvas, lineLengthFt } from "./aerial-canvas";
import { Massing3D } from "./massing-3d";
import { PdfPlanView } from "./pdf-plan-view";
import { PricingPanel } from "./pricing-panel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EditableLine, Measurements } from "@/lib/types";
import type { EstimateResult } from "@/lib/ai";
import type { EstimateHandoff } from "@/lib/estimate-handoff";

export function ResultsView({
  address,
  initial,
  reused,
  jobType = "replacement",
  planId,
}: {
  address: string;
  initial: EstimateResult;
  reused: boolean;
  /** New construction vs replacement. Affects the proposal scope-of-work
   *  language downstream; here we surface it as a chip in the top bar so
   *  the contractor sees what mode they're in. */
  jobType?: "new" | "replacement";
  /** When this estimate came from a plan upload, the PlanAnalysis id.
   *  Passed through to TopBar so the "Re-analyze" button can target
   *  the right row. */
  planId?: string;
}) {
  const [eaves, setEaves] = useState(initial.eaves);
  const [downspouts, setDownspouts] = useState(initial.downspouts);
  const [viewMode, setViewMode] = useState<"plan" | "sheet" | "3d">("plan");
  // The real PDF sheet view is only meaningful for plan-based estimates.
  const hasSheet = !!initial.planSource;
  // Px-per-foot driving LF math. Lifted to state so the "Plan sheet" manual
  // takeoff can re-anchor it to the contractor's click-calibrated scale.
  const [canvasPxPerFt, setCanvasPxPerFt] = useState(initial.canvasPxPerFt);
  // "Plan sheet" working state — calibrated scale (px/ft in canvas space)
  // and the runs traced on the real page. Lifted so they survive tab
  // switches; committed to the priced eaves via applyPlanTrace().
  const [planScale, setPlanScale] = useState<number | null>(null);
  const [planRuns, setPlanRuns] = useState<{ x: number; y: number }[][]>([]);
  // Building outline traced on the Plan sheet → the footprint (roof shape).
  const [planOutline, setPlanOutline] = useState<{ x: number; y: number }[]>([]);
  // Roof outline/skeleton, lifted to state so a traced outline can replace
  // the AI's box footprint and the Roof plan re-derives an accurate roof.
  const [roofStructure, setRoofStructure] = useState(initial.roofStructure);

  const applyPlanTrace = () => {
    if (!planScale || planRuns.length === 0) return;
    const lines: EditableLine[] = planRuns.map((r, i) => ({
      id: `plan-trace-${i}`,
      kind: "eave",
      points: r,
    }));
    setEaves(lines);
    setCanvasPxPerFt(planScale);
    setViewMode("plan");
  };

  const applyOutline = () => {
    if (!planScale || planOutline.length < 3) return;
    // The traced polygon becomes the footprint (roof shape). Eaves come from
    // the separately-traced runs when present, else from the outline edges
    // (all priced as eaves — gable faces get deleted on the Roof plan tab).
    // Both are in the same Plan-sheet canvas space, so they stay aligned.
    const n = planOutline.length;
    const lines: EditableLine[] =
      planRuns.length > 0
        ? planRuns.map((r, i) => ({
            id: `plan-trace-${i}`,
            kind: "eave",
            points: r,
          }))
        : planOutline.map((p, i) => ({
            id: `outline-eave-${i}`,
            kind: "eave",
            points: [p, planOutline[(i + 1) % n]],
          }));
    setEaves(lines);
    setCanvasPxPerFt(planScale);
    setRoofStructure({
      perimeter: planOutline,
      ridges: [],
      valleys: [],
      hips: [],
      confidence: 1,
    });
    setViewMode("plan");
  };
  const can3d =
    (roofStructure?.perimeter?.filter(
      (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
    ).length ?? 0) >= 3;
  // Story count is editable from the property header — homeowners
  // sometimes second-guess a 2-story call when an attached garage
  // looks 1-story on satellite. Default seeded from the AI estimate;
  // contractor overrides with one click.
  const [stories, setStories] = useState(initial.measurements.stories);
  // Bumped by the "bad satellite pic — draw it yourself" banner to arm the
  // canvas's eave-drawing tool.
  const [drawNonce, setDrawNonce] = useState(0);
  const traceQuality = initial.traceQuality;

  const liveEaveLF = Math.round(
    eaves.reduce((acc, l) => {
      // Satellite eaves are COVER-fit onto the canvas, so convert px→ft
      // with the per-estimate scale (not the plan-mode 2.4) — otherwise
      // editing an eave re-prices the job on the wrong scale.
      const v = lineLengthFt(l, canvasPxPerFt);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );

  const measurements: Measurements = {
    ...initial.measurements,
    // Fall back to stored eaveLF when the live sum is 0 — happens
    // when all eaves were dropped at projection time (bad coords on
    // every gutter_run). Without this, the contractor sees "0 LF"
    // even though the stored takeoff has a real LF total.
    eaveLF: liveEaveLF > 0 ? liveEaveLF : initial.measurements.eaveLF,
    downspoutCount: downspouts.length,
    stories,
  };

  // Single handoff payload — captured at click-time by either button.
  // Recomputed each render so live edits to eaves / downspouts are
  // included in whatever the contractor sends to /proposal.
  const handoff: Omit<EstimateHandoff, "capturedAt"> = {
    address,
    measurements,
    eaves,
    rakes: initial.rakes,
    downspouts,
    roofStructure,
    aerial: initial.aerial,
    canvasPxPerFt,
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar
        address={address}
        handoff={handoff}
        jobType={jobType}
        planId={planId}
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex-1"
      >
        <div className="mx-auto grid max-w-[1600px] gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="flex flex-col gap-4">
            <PropertyHeader
              address={address}
              measurements={measurements}
              source={initial.source}
              reused={reused}
              durationMs={initial.durationMs}
              notes={initial.notes}
              onStoriesChange={setStories}
            />
            {traceQuality && traceQuality.status !== "ok" && (
              <BadTraceBanner
                quality={traceQuality}
                hasLines={eaves.length > 0}
                onDrawFresh={() => {
                  setEaves([]);
                  setDrawNonce((n) => n + 1);
                }}
                onKeepAndEdit={() => setDrawNonce((n) => n + 1)}
              />
            )}
            <div className="min-h-[520px] flex-1">
              {/* Roof plan ⇄ 3D view toggle. 3D is a read-only, decorative
                  massing — pricing/LF comes from the same live eaves either
                  way. Disabled without a real roof outline. */}
              <div className="mb-2 inline-flex rounded-full border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
                {(
                  ["plan", hasSheet ? "sheet" : null, "3d"].filter(
                    Boolean,
                  ) as Array<"plan" | "sheet" | "3d">
                ).map((m) => {
                  const active = viewMode === m;
                  const disabled = m === "3d" && !can3d;
                  const label =
                    m === "plan"
                      ? "Roof plan"
                      : m === "sheet"
                        ? "Plan sheet"
                        : "3D";
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={disabled}
                      onClick={() => setViewMode(m)}
                      title={
                        m === "sheet"
                          ? "The actual roof-plan sheet from your PDF"
                          : disabled
                            ? "Needs a roof outline (run a plan takeoff)"
                            : undefined
                      }
                      className={
                        "rounded-full px-3 py-1 font-medium transition " +
                        (active
                          ? "bg-emerald-600 text-white"
                          : disabled
                            ? "cursor-not-allowed text-zinc-400"
                            : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800")
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {viewMode === "sheet" && initial.planSource ? (
                <PdfPlanView
                  planSource={initial.planSource}
                  scalePxPerFt={planScale}
                  onScaleChange={setPlanScale}
                  runs={planRuns}
                  onRunsChange={setPlanRuns}
                  onApply={applyPlanTrace}
                  outline={planOutline}
                  onOutlineChange={setPlanOutline}
                  onApplyOutline={applyOutline}
                />
              ) : viewMode === "3d" && can3d ? (
                <Massing3D
                  eaves={eaves}
                  rakes={initial.rakes}
                  downspouts={downspouts}
                  roofStructure={roofStructure}
                  planSource={initial.planSource}
                  stories={stories}
                />
              ) : (
                <AerialCanvas
                  eaves={eaves}
                  rakes={initial.rakes}
                  downspouts={downspouts}
                  onEavesChange={setEaves}
                  onDownspoutsChange={setDownspouts}
                  aerialImageUrl={initial.aerial?.imageDataUrl}
                  planSource={initial.planSource}
                  roofStructure={roofStructure}
                  pxPerFt={canvasPxPerFt}
                  armDrawNonce={drawNonce}
                />
              )}
            </div>
            <SiteContext />
          </div>

          <div className="lg:sticky lg:top-[72px] lg:self-start">
            <div className="rounded-2xl border border-zinc-200 bg-white shadow-card">
              <div className="h-[calc(100vh-7rem)] overflow-hidden lg:max-h-[calc(100vh-7rem)]">
                <PricingPanel measurements={measurements} handoff={handoff} />
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function PropertyHeader({
  address,
  measurements,
  source,
  reused,
  durationMs,
  notes,
  onStoriesChange,
}: {
  address: string;
  measurements: Measurements;
  source: EstimateResult["source"];
  reused: boolean;
  durationMs: number;
  notes: string[];
  /** Optional callback to override the AI's story-count guess. When
   *  provided, renders the story segment as a clickable picker so the
   *  contractor can confirm or correct the AI's call in one tap. */
  onStoriesChange?: (n: 1 | 2 | 3) => void;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-zinc-400" />
            <h1 className="truncate font-display text-lg font-semibold tracking-tight text-zinc-900">
              {address}
            </h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            {onStoriesChange ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                  Stories
                </span>
                <span className="inline-flex overflow-hidden rounded-full border border-zinc-200 bg-zinc-50/50">
                  {([1, 2, 3] as const).map((n) => {
                    const active = measurements.stories === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => onStoriesChange(n)}
                        className={
                          "px-2 py-0.5 text-xs font-semibold tabular-nums transition " +
                          (active
                            ? "bg-accent-600 text-white"
                            : "text-zinc-600 hover:bg-white hover:text-zinc-900")
                        }
                        title={`Set to ${n}-story`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </span>
              </span>
            ) : (
              <span>
                <span className="text-zinc-700">
                  {measurements.stories}-story
                </span>{" "}
                single-family
              </span>
            )}
            <span>·</span>
            <span>
              <span className="text-zinc-700">
                {measurements.outsideCorners + measurements.insideCorners}
              </span>{" "}
              corners
            </span>
            <span>·</span>
            <span>
              <span className="text-zinc-700">
                {measurements.wasteFactorPct}%
              </span>{" "}
              waste factor
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>
            <Ruler className="h-3 w-3" />
            {measurements.eaveLF} LF eaves
          </Badge>
          <Badge tone="neutral">
            {measurements.downspoutCount} downspouts
          </Badge>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
        <SourceBadge source={source} />
        {reused && (
          <Badge tone="neutral">
            <RefreshCcw className="h-3 w-3" />
            Reused (no credit)
          </Badge>
        )}
        <span>· {durationMs} ms</span>
        {notes.map((n) => (
          <span key={n} className="rounded-full bg-zinc-100 px-2 py-0.5">
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: EstimateResult["source"] }) {
  if (source === "ai") {
    return (
      <Badge tone="accent">
        <Sparkles className="h-3 w-3" />
        AI takeoff
      </Badge>
    );
  }
  if (source === "partial") {
    return (
      <Badge tone="amber">
        <Sparkles className="h-3 w-3" />
        Partial AI · geometry pending
      </Badge>
    );
  }
  return (
    <Badge tone="violet">
      <Sparkles className="h-3 w-3" />
      Mock data
    </Badge>
  );
}

function SiteContext() {
  const items = [
    { label: "Front facade", note: "Exposure: South" },
    { label: "Driveway side", note: "Easy ladder access" },
    { label: "Backyard", note: "Tree overhang — gutter guards rec." },
  ];
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-zinc-400" />
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Site context
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {items.map((it) => (
          <div
            key={it.label}
            className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-3"
          >
            <div className="text-sm font-medium text-zinc-900">{it.label}</div>
            <div className="mt-0.5 text-xs text-zinc-500">{it.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "Bad satellite pic — draw it yourself" banner. Shown above the canvas
 * when the server flags the auto-trace as low/unusable (blurry tile, lines
 * off the roof, length that can't be this roof). The CTA arms the canvas's
 * eave-drawing tool; for an unusable trace it can also clear the junk lines
 * so the contractor starts from a clean roof.
 */
function BadTraceBanner({
  quality,
  hasLines,
  onDrawFresh,
  onKeepAndEdit,
}: {
  quality: NonNullable<EstimateResult["traceQuality"]>;
  hasLines: boolean;
  onDrawFresh: () => void;
  onKeepAndEdit: () => void;
}) {
  const unusable = quality.status === "unusable";
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-card",
        unusable ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-white",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            unusable ? "bg-amber-100 text-amber-700" : "bg-zinc-100 text-zinc-600",
          )}
        >
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-900">
            {unusable
              ? "Sorry — this satellite image was too unclear to measure"
              : "Heads up — double-check this trace"}
          </div>
          <p className="mt-0.5 text-sm text-zinc-600">
            {unusable
              ? "We couldn't reliably trace the gutters from this aerial. Switch to the drawing tool and click along each roof edge to measure them yourself."
              : "Part of the auto-trace looks off the roof. Verify it, or redraw it with the drawing tool."}
            {quality.reasons[0] ? (
              <span className="text-zinc-400"> — {quality.reasons[0]}</span>
            ) : null}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onDrawFresh}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-zinc-900 px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
            >
              <PencilRuler className="h-4 w-4" />
              {unusable && hasLines
                ? "Clear & draw gutters"
                : "Draw gutters myself"}
            </button>
            {unusable && hasLines && (
              <button
                type="button"
                onClick={onKeepAndEdit}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 text-sm font-medium text-zinc-700 transition hover:border-zinc-300"
              >
                Keep AI lines & edit
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
