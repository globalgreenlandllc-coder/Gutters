"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2,
  Hash,
  Layers,
  Maximize2,
  Minimize2,
  MountainSnow,
  MousePointer2,
  Plus,
  Ruler,
  Sparkles,
  Sun,
  SunDim,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STORY_HEIGHT_FT,
  storiesFromHeightFt,
  type Downspout,
  type EditableLine,
  type RoofStructure,
  type Stories,
} from "@/lib/types";
import {
  AerialBackground,
  AerialImage,
  BlueprintBackground,
  CanvasTheme,
  NeonDefs,
  RoofStructureOverlay,
  THEMES,
  VIEWBOX_W,
  VIEWBOX_H,
  pathFor,
  dist,
  lineLengthFt,
} from "./aerial-shared";

type Tool = "select" | "add-eave" | "add-downspout";

export { lineLengthFt };

export function AerialCanvas({
  eaves,
  rakes = [],
  downspouts,
  onEavesChange,
  onDownspoutsChange,
  aerialImageUrl,
  planSource,
  roofStructure,
}: {
  eaves: EditableLine[];
  /** Edges the classifier flagged as rakes (no-gutter). Rendered as
   *  gray-dashed lines for verification; non-interactive. */
  rakes?: EditableLine[];
  downspouts: Downspout[];
  onEavesChange: (next: EditableLine[]) => void;
  onDownspoutsChange: (next: Downspout[]) => void;
  aerialImageUrl?: string;
  /** Plan-based takeoffs: PDF reference for the canvas to rasterize as
   *  the background. Mutually exclusive with aerialImageUrl in practice
   *  — address mode sets aerialImageUrl, plan mode sets planSource. */
  planSource?: { pdfUrl: string; pageIndex: number };
  roofStructure?: RoofStructure;
}) {
  const [theme, setTheme] = useState<CanvasTheme>("tactical");
  const t = THEMES[theme];
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Roof-structure perimeter (the white outline the AI detected) used
  // to render by default — useful for verifying the AI's roof
  // recognition, distracting once the contractor is editing the
  // gutter trace. Toolbar still has the eye toggle to bring it back.
  const [showRoofStructure, setShowRoofStructure] = useState(false);
  // Rakes ship hidden by default. They're informational (the gray-
  // dashed 'AI says no gutter here' lines), but they painted across
  // the satellite image and made the trace look noisy after the
  // takeoff finalized. Contractor can re-enable via the toolbar
  // toggle if they want to verify what the AI excluded.
  const [showRakes, setShowRakes] = useState(false);
  // Fullscreen lifts the canvas to the viewport so you can see the
  // full roof while nudging eaves/downspouts. Independent of theme.
  const [fullscreen, setFullscreen] = useState(false);
  // Low-glow mode dims the neon glow + scrim so the satellite image
  // reads cleanly under the takeoff. Critical when squinting at a
  // pixelated roof edge to decide where the gutter actually sits.
  const [lowGlow, setLowGlow] = useState(false);
  // First-time coach mark — fades in after the trace lands so the
  // contractor knows the AI handed off to them and how to fix it.
  // Once dismissed, stays dismissed for this canvas mount; can be
  // re-shown on a fresh estimate run if needed.
  const [coachOpen, setCoachOpen] = useState(true);
  // Pan + zoom on the satellite image. `view` is the visible viewBox
  // window over the full VIEWBOX_W × VIEWBOX_H content space. Wheel
  // scales (toward cursor), space+drag or right-click+drag pans.
  const [view, setView] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>({ x: 0, y: 0, width: VIEWBOX_W, height: VIEWBOX_H });
  const [panning, setPanning] = useState<{
    sx: number;
    sy: number;
    vx: number;
    vy: number;
    /** Has the cursor moved enough to count as a pan? If false on
     *  pointer up, treat the gesture as a click (deselect) instead. */
    moved: boolean;
  } | null>(null);
  const resetView = () =>
    setView({ x: 0, y: 0, width: VIEWBOX_W, height: VIEWBOX_H });
  // Popover anchor in container-pixel coords. Updated by an effect
  // whenever the selected downspout, pan, or zoom changes — having
  // it as state means it actually re-renders on view changes, which
  // an inline IIFE wasn't doing reliably across paint cycles.
  const [dsPopoverPos, setDsPopoverPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // null = "auto": labels are shown but tiny crowded ones are skipped. The
  // user can force them all-on or all-off with the toolbar toggle.
  const [showLfLabels, setShowLfLabels] = useState<"auto" | "on" | "off">(
    "auto",
  );
  const [drag, setDrag] = useState<
    | { kind: "vertex"; lineId: string; index: number }
    | { kind: "downspout"; id: string }
    | {
        kind: "line";
        lineId: string;
        /** Where on the line the user grabbed (in viewBox coords) so we
         *  can apply a delta relative to that grab point on every move. */
        grabX: number;
        grabY: number;
        /** Snapshot of the line's points at grab time — translate from
         *  these so jitter during the drag doesn't accumulate rounding. */
        origPoints: { x: number; y: number }[];
      }
    | null
  >(null);
  const [drawing, setDrawing] = useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);

  const totalEaveLF = useMemo(
    () => Math.round(eaves.reduce((acc, l) => acc + lineLengthFt(l), 0)),
    [eaves],
  );

  // Render scale — inverse of zoom. As the user zooms in (view.width
  // shrinks), strokes and handles need to render at smaller viewBox
  // sizes to stay visually constant on screen. Without this, vertex
  // handles balloon up at 5× zoom and cover the roof corners you're
  // trying to align to.
  const renderScale = view.width / VIEWBOX_W;

  // Roof centroid in viewBox coords — computed once from all eave
  // endpoints and passed to every label so each label can push itself
  // AWAY from the roof's center (i.e. land on the outside of the
  // polygon). Previously labels pushed toward the canvas center, which
  // put them INSIDE the roof outline — exactly what the contractor
  // didn't want.
  const eavesCentroid = useMemo(() => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const line of eaves) {
      for (const pt of line.points) {
        sx += pt.x;
        sy += pt.y;
        n++;
      }
    }
    if (n === 0) return { x: VIEWBOX_W / 2, y: VIEWBOX_H / 2 };
    return { x: sx / n, y: sy / n };
  }, [eaves]);

  // Decide which eaves get an always-visible LF label. In "off" mode none
  // do (selected still renders its own larger label). In "on" mode all do.
  // "auto" hides labels under a length threshold that climbs as the
  // perimeter gets more crowded — keeps the long walls labeled but stops
  // tiny jog segments from stacking on top of each other.
  const labelVisibleIds = useMemo(() => {
    if (showLfLabels === "off") return new Set<string>();
    if (showLfLabels === "on") return new Set(eaves.map((l) => l.id));
    const lengths = eaves.map((l) => lineLengthFt(l));
    const totalSegments = lengths.length;
    const tinyCount = lengths.filter((ft) => ft < 10).length;
    const crowded = totalSegments >= 12 && tinyCount / totalSegments >= 0.4;
    const threshold = crowded ? 12 : 6;
    const ids = new Set<string>();
    eaves.forEach((l, i) => {
      if (lengths[i] >= threshold) ids.add(l.id);
    });
    return ids;
  }, [eaves, showLfLabels]);

  const selectedDownspout = useMemo(
    () => downspouts.find((d) => d.id === selectedId) ?? null,
    [downspouts, selectedId],
  );

  // Recompute popover anchor whenever the selection or the view
  // changes. SVG ref is read synchronously inside the effect — it's
  // guaranteed to be populated by the time selectedDownspout is set
  // (the user had to click the dot inside the SVG to select it).
  useEffect(() => {
    if (!selectedDownspout) {
      setDsPopoverPos(null);
      return;
    }
    const svg = svgRef.current;
    if (!svg) {
      setDsPopoverPos(null);
      return;
    }
    const rect = svg.getBoundingClientRect();
    const parent = svg.parentElement;
    const parentRect = parent?.getBoundingClientRect() ?? rect;
    const xRatio = (selectedDownspout.x - view.x) / view.width;
    const yRatio = (selectedDownspout.y - view.y) / view.height;
    setDsPopoverPos({
      x: rect.left - parentRect.left + xRatio * rect.width,
      y: rect.top - parentRect.top + yRatio * rect.height,
    });
  }, [
    selectedDownspout,
    view.x,
    view.y,
    view.width,
    view.height,
    fullscreen,
  ]);

  function svgPoint(e: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  // Magnetic-snap helper. Pulls a drag/draw point onto a nearby existing
  // eave endpoint so the gutter runs chain cleanly without microgaps.
  // Two important rules:
  //   1. Snap radius is in viewBox units BUT scales with the current
  //      zoom so it always feels like a fingertip on screen rather
  //      than a half-roof-wide magnet at high zoom.
  //   2. Only EAVE endpoints qualify. Rakes (gray-dashed no-gutter
  //      lines) are visible in the canvas but vertex-snapping onto them
  //      would yank an eave's corner into a position the contractor
  //      didn't want — which is exactly the 'snaps to the white line'
  //      complaint. We're already iterating `eaves` only; this comment
  //      is here so the next change doesn't forget.
  function snapToCorner(
    p: { x: number; y: number },
    excludeLineId: string | null = null,
  ): { x: number; y: number } {
    const SNAP_RADIUS = 6 * Math.max(renderScale, 0.5);
    let best: { x: number; y: number } | null = null;
    let bestDist = SNAP_RADIUS;
    for (const line of eaves) {
      if (line.id === excludeLineId) continue;
      for (const pt of line.points) {
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestDist) {
          bestDist = d;
          best = pt;
        }
      }
    }
    return best ?? p;
  }

  function handlePointerDown(e: React.PointerEvent) {
    const p = svgPoint(e);
    if (tool === "add-eave") {
      const snapped = snapToCorner(p);
      if (drawing) {
        // SECOND click — commit the eave from the stored start to here.
        // Two-click flow matches the contractor's mental model: same
        // 'click here, click there' rhythm as add-downspout, just two
        // taps. The old drag-to-draw required a continuous gesture
        // the user couldn't tell was needed.
        const len = dist(drawing.start, snapped);
        const threshold = Math.max(3, view.width * 0.015);
        if (len > threshold) {
          const id = `eave-${Date.now()}`;
          onEavesChange([
            ...eaves,
            { id, kind: "eave", points: [drawing.start, snapped] },
          ]);
          setSelectedId(id);
        }
        setDrawing(null);
        setTool("select");
        return;
      }
      // FIRST click — record the start point. The end point tracks the
      // cursor via pointermove until the next click commits the eave.
      setDrawing({ start: snapped, end: snapped });
      return;
    }
    if (tool === "add-downspout") {
      const id = `ds-${Date.now()}`;
      onDownspoutsChange([...downspouts, { id, x: p.x, y: p.y, heightFt: 20 }]);
      setSelectedId(id);
      setTool("select");
      return;
    }
    setSelectedId(null);
  }

  function handlePointerMove(e: React.PointerEvent) {
    const p = svgPoint(e);
    if (drawing && tool === "add-eave") {
      // Live-update the preview end. Works WITHOUT a held drag —
      // pointermove fires whenever the cursor moves over the SVG so
      // the preview follows the mouse from click-1 to click-2.
      setDrawing({ ...drawing, end: snapToCorner(p) });
      return;
    }
    if (drag?.kind === "vertex") {
      // Snap dragged vertex to another eave's endpoint — but exclude
      // the line we're dragging, otherwise the snap pulls onto our
      // own opposite endpoint and collapses the eave.
      const snapped = snapToCorner(p, drag.lineId);
      onEavesChange(
        eaves.map((l) =>
          l.id === drag.lineId
            ? {
                ...l,
                points: l.points.map((pt, i) =>
                  i === drag.index ? snapped : pt,
                ),
              }
            : l,
        ),
      );
    } else if (drag?.kind === "line") {
      // Translate the entire line by (cursor − grab) relative to its
      // grab-time snapshot. Both endpoints move together — same shape,
      // shifted. Lets the contractor nudge an entire run sideways
      // without grabbing each corner.
      const dx = p.x - drag.grabX;
      const dy = p.y - drag.grabY;
      onEavesChange(
        eaves.map((l) =>
          l.id === drag.lineId
            ? {
                ...l,
                points: drag.origPoints.map((pt) => ({
                  x: pt.x + dx,
                  y: pt.y + dy,
                })),
              }
            : l,
        ),
      );
    } else if (drag?.kind === "downspout") {
      onDownspoutsChange(
        downspouts.map((d) => (d.id === drag.id ? { ...d, x: p.x, y: p.y } : d)),
      );
    }
  }

  function handlePointerUp() {
    // Eave drawing is now click-click, not click-and-drag, so we
    // intentionally don't commit anything on pointer-up. The second
    // click in handlePointerDown commits the eave.
    setDrag(null);
  }

  function deleteSelected() {
    if (!selectedId) return;
    if (eaves.some((l) => l.id === selectedId)) {
      onEavesChange(eaves.filter((l) => l.id !== selectedId));
    } else if (downspouts.some((d) => d.id === selectedId)) {
      onDownspoutsChange(downspouts.filter((d) => d.id !== selectedId));
    }
    setSelectedId(null);
  }

  // Delete / Backspace removes the current selection. Bail when the
  // keystroke targets a real input — otherwise the contractor types in
  // the estimate-builder fields and accidentally erases an eave.
  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      e.preventDefault();
      deleteSelected();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // deleteSelected closes over selectedId/eaves/downspouts; rebinding
    // when selection changes is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Esc exits fullscreen. Skipped when fullscreen isn't active so the
  // global Esc handlers in the rest of the app aren't doubly bound.
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullscreen]);

  // Switching to a non-select tool (Add eave / Add downspout) clears
  // the current selection. Without this, the previously-selected
  // line's corner handles stay on top of the canvas and intercept
  // pointer-down events — so clicking the satellite to start a new
  // eave never reaches the SVG and the drawing doesn't appear.
  useEffect(() => {
    if (tool !== "select") {
      setSelectedId(null);
    }
  }, [tool]);

  // Esc-to-deselect. Convenient because the new "left-drag pans when
  // zoomed in" behavior swallows the old "click empty space to
  // deselect" gesture — Esc gives the contractor that escape hatch
  // back without making them tap a different tool.
  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA")
      )
        return;
      setSelectedId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "group/canvas relative w-full overflow-hidden border shadow-card transition-all",
        fullscreen
          ? "fixed inset-0 z-50 h-screen rounded-none"
          : "h-full rounded-2xl",
        theme === "tactical"
          ? "border-cyan-900/40 bg-slate-950"
          : "border-zinc-200 bg-zinc-100",
        // CSS variable powering the global glow intensity — every neon
        // filter below references it so one toggle reaches the whole tree.
        lowGlow ? "[--glow-strength:0.15]" : "[--glow-strength:1]",
      )}
      // Marker for plan-based takeoffs — used to switch to the
      // drafting-paper BlueprintBackground further down. Address-mode
      // estimates leave this unset and use the satellite/cartoon path.
      data-plan-takeoff={planSource ? "1" : undefined}
      data-low-glow={lowGlow ? "1" : "0"}
    >
      <Toolbar
        tool={tool}
        setTool={setTool}
        canDelete={!!selectedId}
        onDelete={deleteSelected}
        theme={theme}
        onThemeToggle={() =>
          setTheme((th) => (th === "tactical" ? "schematic" : "tactical"))
        }
        roofStructureAvailable={!!roofStructure}
        showRoofStructure={showRoofStructure}
        onToggleRoofStructure={() => setShowRoofStructure((s) => !s)}
        rakesAvailable={rakes.length > 0}
        showRakes={showRakes}
        onToggleRakes={() => setShowRakes((s) => !s)}
        lfLabelMode={showLfLabels}
        onCycleLfLabels={() =>
          setShowLfLabels((m) =>
            m === "auto" ? "off" : m === "off" ? "on" : "auto",
          )
        }
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((v) => !v)}
        lowGlow={lowGlow}
        onToggleLowGlow={() => setLowGlow((v) => !v)}
      />
      <Legend
        rakeCount={rakes.length}
        totalEaveLF={totalEaveLF}
        downspoutCount={downspouts.length}
        theme={theme}
      />
      {/* Roof-structure banner only shows when no downspout is
          selected — otherwise it overlaps with the downspout-height
          popover at the bottom of the canvas, and both are
          unreadable. */}
      {roofStructure && showRoofStructure && !selectedDownspout && (
        <RoofStructureBanner confidence={roofStructure.confidence} />
      )}

      {/* Zoom controls — bottom-right. Mouse-wheel zooms toward cursor;
          these buttons step in/out by 25% and reset to fit. */}
      <div
        className={cn(
          "absolute bottom-3 right-3 z-10 flex flex-col gap-1 rounded-lg border p-1 shadow-card backdrop-blur",
          theme === "tactical"
            ? "border-cyan-500/30 bg-slate-950/80"
            : "border-zinc-200 bg-white/95",
        )}
      >
        <button
          onClick={() => {
            const cx = view.x + view.width / 2;
            const cy = view.y + view.height / 2;
            const w = Math.max(VIEWBOX_W / 5, view.width / 1.25);
            const h = w * (view.height / view.width);
            setView({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
          }}
          title="Zoom in"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md text-lg font-semibold transition",
            theme === "tactical"
              ? "text-cyan-200/80 hover:bg-cyan-500/15 hover:text-cyan-100"
              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          +
        </button>
        <button
          onClick={() => {
            const cx = view.x + view.width / 2;
            const cy = view.y + view.height / 2;
            const w = Math.min(VIEWBOX_W * 4, view.width * 1.25);
            const h = w * (view.height / view.width);
            setView({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
          }}
          title="Zoom out"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md text-lg font-semibold transition",
            theme === "tactical"
              ? "text-cyan-200/80 hover:bg-cyan-500/15 hover:text-cyan-100"
              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          −
        </button>
        <button
          onClick={resetView}
          title="Fit to view"
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md transition",
            theme === "tactical"
              ? "text-cyan-200/80 hover:bg-cyan-500/15 hover:text-cyan-100"
              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {coachOpen && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.4 }}
          className={cn(
            "absolute left-1/2 top-3 z-10 -translate-x-1/2 max-w-[92%]",
          )}
        >
          <div
            className={cn(
              "flex items-start gap-2.5 rounded-xl border px-3 py-2 shadow-elevated backdrop-blur",
              theme === "tactical"
                ? "border-cyan-400/40 bg-slate-950/85 text-cyan-50"
                : "border-zinc-200 bg-white/95 text-zinc-800",
            )}
          >
            <span
              className={cn(
                "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                theme === "tactical"
                  ? "bg-cyan-400/20 text-cyan-200 ring-1 ring-inset ring-cyan-300/40"
                  : "bg-accent-100 text-accent-700 ring-1 ring-inset ring-accent-200",
              )}
            >
              AI
            </span>
            <div className="text-[12px] leading-snug">
              <div className="font-semibold">
                AI traced your gutters — finish in the drawing tools.
              </div>
              <div
                className={cn(
                  "mt-0.5 text-[11px]",
                  theme === "tactical"
                    ? "text-cyan-200/85"
                    : "text-zinc-500",
                )}
              >
                <strong>Select a line</strong>, drag the body to slide it
                or grab a corner to extend. <strong>Double-click</strong> a
                line to split it. <strong>Add eave</strong>: click once to
                start, click again to finish. <strong>Scroll</strong> to
                zoom, <strong>drag empty space</strong> to pan,{" "}
                <strong>Delete</strong> removes the selected line. Totals
                re-price as you edit.
              </div>
            </div>
            <button
              onClick={() => setCoachOpen(false)}
              className={cn(
                "ml-1 mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition",
                theme === "tactical"
                  ? "text-cyan-200/70 hover:bg-cyan-400/15 hover:text-cyan-100"
                  : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700",
              )}
              aria-label="Dismiss coach mark"
            >
              ×
            </button>
          </div>
        </motion.div>
      )}

      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        preserveAspectRatio="xMidYMid slice"
        onPointerDown={(e) => {
          // Pan on empty-space drag. Three triggers:
          //   1. right-click + drag
          //   2. shift + drag
          //   3. plain left-drag while in select mode AND we're zoomed
          //      in (view < full). At full extent we don't pan because
          //      there's nowhere to go and we'd swallow a deselect click.
          // Drags that originate on an eave / vertex / downspout don't
          // reach here — their handlers stopPropagation() — so this
          // never hijacks a real selection or vertex grab.
          const zoomedIn = view.width < VIEWBOX_W * 0.98;
          if (
            tool === "select" &&
            !drag &&
            (e.button === 2 || e.shiftKey || zoomedIn)
          ) {
            e.preventDefault();
            setPanning({
              sx: e.clientX,
              sy: e.clientY,
              vx: view.x,
              vy: view.y,
              moved: false,
            });
            // Capture the pointer so we keep getting move events even
            // if the cursor leaves the SVG bounds during the drag.
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Some browsers throw on capture for non-mouse pointers.
            }
            return;
          }
          handlePointerDown(e);
        }}
        onPointerMove={(e) => {
          if (panning && svgRef.current) {
            const dxRaw = e.clientX - panning.sx;
            const dyRaw = e.clientY - panning.sy;
            // Movement threshold: 4 screen pixels. Below that, treat
            // the gesture as a click — used on pointer-up to deselect
            // instead of leaving the user stuck because they tapped
            // on empty space while zoomed in.
            if (!panning.moved && Math.hypot(dxRaw, dyRaw) > 4) {
              setPanning({ ...panning, moved: true });
            }
            const rect = svgRef.current.getBoundingClientRect();
            const scaleX = view.width / rect.width;
            const scaleY = view.height / rect.height;
            setView((v) => ({
              ...v,
              x: panning.vx - dxRaw * scaleX,
              y: panning.vy - dyRaw * scaleY,
            }));
            return;
          }
          handlePointerMove(e);
        }}
        onPointerUp={() => {
          if (panning) {
            // No real movement → user tapped empty space. Deselect so
            // the contractor can dismiss a selection without having to
            // remember the Esc key.
            if (!panning.moved) {
              setSelectedId(null);
            }
            setPanning(null);
            return;
          }
          handlePointerUp();
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          // Zoom toward the cursor. Wheel up = zoom in, down = out.
          // Clamp to 0.25× – 5× so the user can't get lost.
          if (!svgRef.current) return;
          e.preventDefault();
          const rect = svgRef.current.getBoundingClientRect();
          const cursorVX = view.x + ((e.clientX - rect.left) / rect.width) * view.width;
          const cursorVY = view.y + ((e.clientY - rect.top) / rect.height) * view.height;
          const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
          const minW = VIEWBOX_W / 5;
          const maxW = VIEWBOX_W * 4;
          const nextW = Math.max(minW, Math.min(maxW, view.width * factor));
          const nextH = nextW * (view.height / view.width);
          // Anchor the cursor at the same image point post-zoom.
          const nextX = cursorVX - ((e.clientX - rect.left) / rect.width) * nextW;
          const nextY = cursorVY - ((e.clientY - rect.top) / rect.height) * nextH;
          setView({ x: nextX, y: nextY, width: nextW, height: nextH });
        }}
        className={cn(
          "h-full w-full touch-none select-none",
          tool === "add-eave" && "cursor-crosshair",
          tool === "add-downspout" && "cursor-copy",
          panning && "cursor-grabbing",
        )}
        style={{ minHeight: 420 }}
      >
        <NeonDefs />
        {aerialImageUrl ? (
          <AerialImage imageDataUrl={aerialImageUrl} />
        ) : planSource ? (
          // Plan-based takeoff: drafting-paper background instead of
          // the cartoon yard scene. We previously tried rasterizing the
          // source PDF page Claude identified, but Claude consistently
          // picked the site plan (page 1) rather than the roof plan
          // page from multi-page sets. A clean architectural canvas
          // looks more presentable AND doesn't depend on us getting
          // page-detection right from the AI.
          <BlueprintBackground />
        ) : (
          <AerialBackground />
        )}
        {t.overlay && !lowGlow && (
          <rect
            x={0}
            y={0}
            width={VIEWBOX_W}
            height={VIEWBOX_H}
            fill={t.overlay}
            pointerEvents="none"
          />
        )}

        {roofStructure && showRoofStructure && (
          <RoofStructureOverlay structure={roofStructure} />
        )}

        {/* Rakes — gray-dashed "no-gutter" lines for verification.
            Rendered BEFORE eaves so cyan eaves draw over the gray when
            the AI classified the same edge two ways (rare but
            possible). Non-interactive — the contractor doesn't edit
            rakes; they confirm visually or ignore. */}
        {showRakes &&
          rakes.map((line) => (
            <path
              key={line.id}
              d={pathFor(line)}
              stroke={theme === "tactical" ? "#94a3b8" : "#64748b"}
              strokeWidth={2 * renderScale}
              strokeDasharray={`${6 * renderScale} ${5 * renderScale}`}
              strokeLinecap="round"
              fill="none"
              opacity={0.7}
              pointerEvents="none"
            />
          ))}

        {eaves.map((line, i) => {
          const isSelected = selectedId === line.id;
          const isHover = hoverId === line.id;
          const stroke = isSelected ? t.eaveSelected : t.eave;
          // Low-glow mode keeps only the selected eave's glow so you
          // can still tell which one you're editing, while the other
          // eaves render as clean strokes that don't bleed across
          // the satellite image's roof edges.
          const filter =
            lowGlow && !isSelected
              ? "none"
              : theme === "tactical"
                ? isSelected
                  ? "drop-shadow(0 0 10px rgba(0,229,255,1))"
                  : "drop-shadow(0 0 6px rgba(0,229,255,0.95))"
                : isSelected
                  ? "drop-shadow(0 1px 6px rgba(14,116,144,0.55))"
                  : "drop-shadow(0 1px 4px rgba(5,150,105,0.45))";
          return (
            <g key={line.id}>
              {/* Plain <path> (not motion.path) — framer-motion's path
                  measurement on every render was a hot spot during
                  drag. Entrance animation isn't needed after the first
                  render of the canvas. */}
              <path
                d={pathFor(line)}
                stroke={stroke}
                strokeWidth={
                  (isSelected ? 5 : isHover ? 4.5 : 3.5) * renderScale
                }
                strokeLinecap="square"
                strokeLinejoin="miter"
                strokeMiterlimit={4}
                fill="none"
                style={{
                  filter,
                  cursor: isSelected ? "move" : "pointer",
                }}
                onPointerDown={(e) => {
                  if (tool !== "select") return;
                  e.stopPropagation();
                  // Selecting the line is always step one. Starting a
                  // body-drag only kicks in on the SECOND mousedown on
                  // an already-selected line — first click is "select".
                  const wasSelected = selectedId === line.id;
                  setSelectedId(line.id);
                  if (wasSelected) {
                    const p = svgPoint(e);
                    setDrag({
                      kind: "line",
                      lineId: line.id,
                      grabX: p.x,
                      grabY: p.y,
                      origPoints: line.points.map((pt) => ({
                        x: pt.x,
                        y: pt.y,
                      })),
                    });
                  }
                }}
                onDoubleClick={(e) => {
                  if (tool !== "select") return;
                  e.stopPropagation();
                  // Double-click on a line body splits it: insert a new
                  // vertex at the click point. The new vertex can be
                  // immediately dragged so the contractor can bend the
                  // line in a new direction (matches the 'split this
                  // piece and move it' ask). We project the click onto
                  // the line first so the vertex lands ON the eave, not
                  // wherever the mouse happened to be 2px off.
                  const p = svgPoint(e);
                  let bestSegIdx = 0;
                  let bestProj: { x: number; y: number } = line.points[0];
                  let bestDist = Infinity;
                  for (let i = 0; i < line.points.length - 1; i++) {
                    const a = line.points[i];
                    const b = line.points[i + 1];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const len2 = dx * dx + dy * dy;
                    if (len2 === 0) continue;
                    const t = Math.max(
                      0,
                      Math.min(
                        1,
                        ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2,
                      ),
                    );
                    const proj = { x: a.x + t * dx, y: a.y + t * dy };
                    const d = Math.hypot(p.x - proj.x, p.y - proj.y);
                    if (d < bestDist) {
                      bestDist = d;
                      bestSegIdx = i;
                      bestProj = proj;
                    }
                  }
                  const nextPoints = [
                    ...line.points.slice(0, bestSegIdx + 1),
                    bestProj,
                    ...line.points.slice(bestSegIdx + 1),
                  ];
                  onEavesChange(
                    eaves.map((l) =>
                      l.id === line.id ? { ...l, points: nextPoints } : l,
                    ),
                  );
                  setSelectedId(line.id);
                }}
                onPointerEnter={() => setHoverId(line.id)}
                onPointerLeave={() => setHoverId(null)}
              />
              {/* LF label policy: show when the line is just hovered or
                  ambient-labeled, but HIDE when the line is selected.
                  The contractor is editing — they don't need the LF
                  reading hovering near the corner handles where they're
                  trying to click. The total LF is shown in the legend
                  anyway, and the pricing tab updates live. */}
              {/* Labels during active drag are pure waste — they re-
                  position every frame, retrigger SVG layout, and the
                  contractor isn't reading numbers while dragging.
                  Suppress them while ANY drag is in progress. */}
              {!drag &&
                !isSelected &&
                (labelVisibleIds.has(line.id) || isHover) && (
                  <LineLabel
                    line={line}
                    theme={theme}
                    emphasized={false}
                    animationDelay={0.6 + i * 0.06}
                    outsideAnchor={eavesCentroid}
                    renderScale={renderScale}
                  />
                )}
              {/* Vertex handles render LAST so they sit on top of any
                  LF label that might land near a corner. Also enlarged
                  the hit area (transparent ring + visible dot) so the
                  dots stay clickable even when an label is right there. */}
              {isSelected &&
                line.points.map((pt, idx) => {
                  // Pure screen-constant sizing. visibleSize = 14
                  // viewBox units AT renderScale=1 (default zoom);
                  // shrinking in lockstep with the zoom so 14 px on
                  // screen is the constant size at every zoom level.
                  // No floor on the visible square — at extreme zoom
                  // we'd rather have a tiny dot than a giant box that
                  // hides the corner.
                  // Hit radius gets a small viewBox floor so the
                  // grab zone stays usable even when zoomed out hard.
                  const hitR = Math.max(14 * renderScale, 6);
                  const visibleSize = 14 * renderScale;
                  const half = visibleSize / 2;
                  return (
                    <g key={idx}>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={hitR}
                        fill="transparent"
                        style={{ cursor: "grab" }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setDrag({
                            kind: "vertex",
                            lineId: line.id,
                            index: idx,
                          });
                        }}
                      />
                      <rect
                        x={pt.x - half}
                        y={pt.y - half}
                        width={visibleSize}
                        height={visibleSize}
                        rx={2.5 * renderScale}
                        fill={t.handleFill}
                        stroke={t.handleStroke}
                        strokeWidth={2.5 * renderScale}
                        pointerEvents="none"
                      />
                    </g>
                  );
                })}
            </g>
          );
        })}

        {downspouts.map((d) => {
          const isSelected = selectedId === d.id;
          return (
            <g
              key={d.id}
              onPointerDown={(e) => {
                if (tool !== "select") return;
                e.stopPropagation();
                setSelectedId(d.id);
                setDrag({ kind: "downspout", id: d.id });
              }}
              style={{ cursor: "grab" }}
            >
              {(() => {
                // Pure screen-constant downspout sizes. Drops on
                // viewBox scaling alone so a downspout reads the same
                // on screen at default zoom and at 5× zoom rather
                // than ballooning to fill the roof at high zoom.
                const halo = 14 * renderScale;
                const ringR = (isSelected ? 8 : lowGlow ? 4.5 : 6) * renderScale;
                const coreR = 2.4 * renderScale;
                const schematicR = (isSelected ? 12 : 9) * renderScale;
                const schematicCore = 3.5 * renderScale;
                const schematicStroke = 2 * renderScale;
                if (theme === "tactical") {
                  return (
                    <>
                      {isSelected && !lowGlow && (
                        <circle
                          cx={d.x}
                          cy={d.y}
                          r={halo}
                          fill={t.downspout}
                          opacity={0.18}
                          pointerEvents="none"
                        />
                      )}
                      <circle
                        cx={d.x}
                        cy={d.y}
                        r={ringR}
                        fill={t.downspout}
                        filter={
                          lowGlow && !isSelected
                            ? undefined
                            : (t.downspoutGlowFilter ?? undefined)
                        }
                      />
                      <circle cx={d.x} cy={d.y} r={coreR} fill={t.downspoutCore} />
                    </>
                  );
                }
                return (
                  <>
                    <circle
                      cx={d.x}
                      cy={d.y}
                      r={schematicR}
                      fill="white"
                      stroke={
                        isSelected ? t.downspout : "rgba(14,116,144,0.85)"
                      }
                      strokeWidth={schematicStroke}
                    />
                    <circle cx={d.x} cy={d.y} r={schematicCore} fill={t.downspoutCore} />
                  </>
                );
              })()}
            </g>
          );
        })}

        {drawing && (
          <line
            x1={drawing.start.x}
            y1={drawing.start.y}
            x2={drawing.end.x}
            y2={drawing.end.y}
            stroke={t.eave}
            // Stroke + dash pattern scale with zoom so the in-progress
            // preview reads the same on screen at any zoom — was
            // ballooning to a billboard-width dashed line at 5× zoom.
            strokeWidth={3 * renderScale}
            strokeDasharray={`${8 * renderScale} ${5 * renderScale}`}
            opacity="0.95"
            style={{
              filter:
                theme === "tactical"
                  ? "drop-shadow(0 0 6px rgba(0,229,255,0.95))"
                  : undefined,
            }}
          />
        )}
      </svg>

      <AnimatePresence>
        {selectedDownspout ? (
          <DownspoutPopover
            key={selectedDownspout.id}
            downspout={selectedDownspout}
            theme={theme}
            // Anchored above the selected downspout dot via an effect
            // that tracks selection + pan/zoom (more reliable than
            // computing inline every render).
            position={dsPopoverPos ?? undefined}
            onChangeStories={(s) =>
              onDownspoutsChange(
                downspouts.map((d) =>
                  d.id === selectedDownspout.id
                    ? { ...d, heightFt: STORY_HEIGHT_FT[s] }
                    : d,
                ),
              )
            }
            onDelete={deleteSelected}
            onClose={() => setSelectedId(null)}
          />
        ) : selectedId ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2"
          >
            <div
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-elevated backdrop-blur",
                theme === "tactical"
                  ? "border-cyan-500/40 bg-slate-950/80 text-cyan-100"
                  : "border-zinc-200 bg-white/95 text-zinc-700",
              )}
            >
              <span
                className={cn(
                  "rounded-full px-2 py-0.5",
                  theme === "tactical"
                    ? "bg-cyan-500/15 text-cyan-200"
                    : "bg-cyan-50 text-cyan-700",
                )}
              >
                Selected
              </span>
              <span>Drag handles to adjust · Delete to remove</span>
              <button
                onClick={deleteSelected}
                className={cn(
                  "ml-1 rounded-full border px-2 py-0.5 transition",
                  theme === "tactical"
                    ? "border-cyan-500/30 hover:border-rose-400 hover:text-rose-300"
                    : "border-zinc-200 hover:border-rose-300 hover:text-rose-600",
                )}
              >
                <Trash2 className="inline h-3 w-3" />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function DownspoutPopover({
  downspout,
  theme,
  onChangeStories,
  onDelete,
  onClose,
  position,
}: {
  downspout: Downspout;
  theme: CanvasTheme;
  onChangeStories: (s: Stories) => void;
  onDelete: () => void;
  /** Dismiss the popover without deleting the downspout — just clears
   *  the selection. Gives the contractor an obvious X to close out of
   *  edit mode instead of having to remember Esc. */
  onClose: () => void;
  /** Pixel coordinates of the selected downspout in the canvas's
   *  rendered space (NOT viewBox space) — so the popover floats
   *  right next to the dot the contractor just tapped. */
  position?: { x: number; y: number };
}) {
  const current = storiesFromHeightFt(downspout.heightFt);
  const options: { id: Stories; label: string; ft: number }[] = [
    { id: 1, label: "1-story", ft: 10 },
    { id: 2, label: "2-story", ft: 20 },
    { id: 3, label: "3-story", ft: 30 },
  ];
  const inlineStyle = position
    ? {
        left: position.x,
        top: position.y - 56, // sit just above the dot
        transform: "translateX(-50%)",
      }
    : undefined;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className={
        position
          ? "absolute z-20"
          : "absolute bottom-4 left-1/2 -translate-x-1/2"
      }
      style={inlineStyle}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs shadow-elevated backdrop-blur",
          theme === "tactical"
            ? "border-fuchsia-500/40 bg-slate-950/85 text-fuchsia-100"
            : "border-zinc-200 bg-white/95 text-zinc-700",
        )}
      >
        <Building2
          className={cn(
            "h-3.5 w-3.5",
            theme === "tactical" ? "text-fuchsia-300" : "text-zinc-500",
          )}
        />
        <span className="font-medium">Downspout height</span>
        <div
          className={cn(
            "flex items-center gap-1 rounded-full p-0.5",
            theme === "tactical" ? "bg-slate-900/80" : "bg-zinc-100",
          )}
        >
          {options.map((o) => {
            const active = o.id === current;
            return (
              <button
                key={o.id}
                onClick={() => onChangeStories(o.id)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium transition",
                  active
                    ? theme === "tactical"
                      ? "bg-fuchsia-500/90 text-white shadow-[0_0_8px_rgba(255,43,214,0.6)]"
                      : "bg-cyan-600 text-white"
                    : theme === "tactical"
                      ? "text-fuchsia-200/70 hover:text-fuchsia-100"
                      : "text-zinc-600 hover:text-zinc-900",
                )}
              >
                {o.label}
                <span className="ml-1 text-[10px] opacity-70">{o.ft} ft</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onDelete}
          title="Delete downspout"
          className={cn(
            "ml-1 rounded-full border px-2 py-1 transition",
            theme === "tactical"
              ? "border-fuchsia-500/30 hover:border-rose-400 hover:text-rose-300"
              : "border-zinc-200 hover:border-rose-300 hover:text-rose-600",
          )}
        >
          <Trash2 className="inline h-3 w-3" />
        </button>
        <button
          onClick={onClose}
          title="Close (Esc)"
          className={cn(
            "ml-0.5 flex h-7 w-7 items-center justify-center rounded-full transition",
            theme === "tactical"
              ? "text-fuchsia-200/80 hover:bg-fuchsia-500/15 hover:text-white"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
          )}
          aria-label="Close downspout editor"
        >
          ×
        </button>
      </div>
    </motion.div>
  );
}

function Toolbar({
  tool,
  setTool,
  canDelete,
  onDelete,
  theme,
  onThemeToggle,
  roofStructureAvailable,
  showRoofStructure,
  onToggleRoofStructure,
  rakesAvailable,
  showRakes,
  onToggleRakes,
  lfLabelMode,
  onCycleLfLabels,
  fullscreen,
  onToggleFullscreen,
  lowGlow,
  onToggleLowGlow,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  canDelete: boolean;
  onDelete: () => void;
  theme: CanvasTheme;
  onThemeToggle: () => void;
  roofStructureAvailable: boolean;
  showRoofStructure: boolean;
  onToggleRoofStructure: () => void;
  rakesAvailable: boolean;
  showRakes: boolean;
  onToggleRakes: () => void;
  lfLabelMode: "auto" | "on" | "off";
  onCycleLfLabels: () => void;
  /** Lifts the canvas to fixed/full-viewport so the contractor can
   *  nudge eaves at full zoom rather than fighting the sidebar. */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Drops the cyan glow filter + scrim so the satellite image reads
   *  clearly under the takeoff. Critical when verifying eave placement
   *  against pixelated roof edges. */
  lowGlow: boolean;
  onToggleLowGlow: () => void;
}) {
  const tools: { id: Tool; icon: typeof MousePointer2; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Select" },
    { id: "add-eave", icon: Plus, label: "Add eave" },
    { id: "add-downspout", icon: Layers, label: "Add downspout" },
  ];
  const tactical = theme === "tactical";
  return (
    <div
      className={cn(
        "absolute left-4 top-4 z-10 flex flex-col gap-1 rounded-xl border p-1 shadow-card backdrop-blur",
        tactical
          ? "border-cyan-500/30 bg-slate-950/80"
          : "border-zinc-200 bg-white/95",
      )}
    >
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id)}
          title={t.label}
          className={cn(
            "group/tool flex h-10 items-center gap-2 rounded-lg pl-2 pr-2.5 transition",
            tool === t.id
              ? tactical
                ? "bg-cyan-500/25 text-cyan-100 ring-1 ring-inset ring-cyan-400/60"
                : "bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200"
              : tactical
                ? "text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          <t.icon className="h-4 w-4 shrink-0" />
          <span
            className={cn(
              "text-[11px] font-semibold transition-all",
              tool === t.id
                ? "max-w-[120px] opacity-100"
                : "max-w-0 overflow-hidden opacity-0 group-hover/tool:max-w-[120px] group-hover/tool:opacity-100",
            )}
          >
            {t.label}
          </span>
        </button>
      ))}
      <div
        className={cn(
          "my-1 h-px w-full",
          tactical ? "bg-cyan-500/20" : "bg-zinc-200",
        )}
      />
      <button
        onClick={onDelete}
        disabled={!canDelete}
        title="Delete selection"
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg transition disabled:opacity-40",
          tactical
            ? "text-cyan-200/70 hover:bg-rose-500/15 hover:text-rose-300 disabled:hover:bg-transparent disabled:hover:text-cyan-200/70"
            : "text-zinc-500 hover:bg-rose-50 hover:text-rose-600 disabled:hover:bg-transparent disabled:hover:text-zinc-500",
        )}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <div
        className={cn(
          "my-1 h-px w-full",
          tactical ? "bg-cyan-500/20" : "bg-zinc-200",
        )}
      />
      <button
        onClick={onThemeToggle}
        title={tactical ? "Switch to schematic" : "Switch to tactical"}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg transition",
          tactical
            ? "text-fuchsia-300 hover:bg-fuchsia-500/15"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
        )}
      >
        <Sparkles className="h-4 w-4" />
      </button>
      {roofStructureAvailable && (
        <button
          onClick={onToggleRoofStructure}
          title={
            showRoofStructure
              ? "Hide roof structure (perimeter / ridges / valleys)"
              : "Show roof structure (perimeter / ridges / valleys)"
          }
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg transition",
            showRoofStructure
              ? tactical
                ? "bg-white/15 text-white ring-1 ring-inset ring-white/40"
                : "bg-zinc-900/10 text-zinc-900 ring-1 ring-inset ring-zinc-300"
              : tactical
                ? "text-cyan-200/70 hover:bg-white/10 hover:text-white"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          <MountainSnow className="h-4 w-4" />
        </button>
      )}
      {rakesAvailable && (
        <button
          onClick={onToggleRakes}
          title={
            showRakes
              ? "Hide rakes (gray dashed — no gutter)"
              : "Show rakes (gray dashed — no gutter)"
          }
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg transition",
            showRakes
              ? tactical
                ? "bg-slate-700/50 text-slate-200 ring-1 ring-inset ring-slate-500/50"
                : "bg-slate-200 text-slate-700 ring-1 ring-inset ring-slate-300"
              : tactical
                ? "text-cyan-200/70 hover:bg-slate-700/30 hover:text-slate-200"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          {/* Slash icon: communicates "excluded" — gutters slash. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="5" y1="19" x2="19" y2="5" strokeDasharray="3 2" />
          </svg>
        </button>
      )}
      <button
        onClick={onCycleLfLabels}
        title={
          lfLabelMode === "auto"
            ? "LF labels: auto (hides crowded short segments)"
            : lfLabelMode === "on"
              ? "LF labels: all visible"
              : "LF labels: hidden"
        }
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg transition",
          lfLabelMode === "off"
            ? tactical
              ? "text-cyan-200/40 hover:bg-cyan-500/10 hover:text-cyan-100"
              : "text-zinc-300 hover:bg-zinc-100 hover:text-zinc-700"
            : lfLabelMode === "on"
              ? tactical
                ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-inset ring-cyan-400/50"
                : "bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200"
              : tactical
                ? "text-cyan-200/80 hover:bg-cyan-500/10 hover:text-cyan-100"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
        )}
      >
        <Hash className="h-4 w-4" />
      </button>
      <div
        className={cn(
          "my-1 h-px w-full",
          tactical ? "bg-cyan-500/20" : "bg-zinc-200",
        )}
      />
      <button
        onClick={onToggleLowGlow}
        title={
          lowGlow
            ? "Restore neon overlay glow"
            : "Dim overlay glow so the satellite image reads clearly"
        }
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg transition",
          lowGlow
            ? tactical
              ? "bg-amber-500/20 text-amber-200 ring-1 ring-inset ring-amber-400/50"
              : "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200"
            : tactical
              ? "text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
        )}
      >
        {lowGlow ? (
          <Sun className="h-4 w-4" />
        ) : (
          <SunDim className="h-4 w-4" />
        )}
      </button>
      <button
        onClick={onToggleFullscreen}
        title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen edit"}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg transition",
          fullscreen
            ? tactical
              ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-inset ring-cyan-400/50"
              : "bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200"
            : tactical
              ? "text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
        )}
      >
        {fullscreen ? (
          <Minimize2 className="h-4 w-4" />
        ) : (
          <Maximize2 className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

function RoofStructureBanner({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const lowConfidence = confidence < 0.7;
  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full border border-white/20 bg-slate-950/75 px-3 py-1.5 text-[11px] font-medium text-white/90 shadow-elevated backdrop-blur">
        <span className="h-2 w-2 rounded-full bg-white" />
        <span>Perimeter Outline</span>
        <span className="mx-1 h-3 w-px bg-white/25" />
        <span className={cn(lowConfidence ? "text-amber-300" : "text-white/70")}>
          {lowConfidence ? "Visual approx — verify before estimating" : `Approximation · ${pct}% conf`}
        </span>
      </div>
    </div>
  );
}

function Legend({
  totalEaveLF,
  rakeCount,
  downspoutCount,
  theme,
}: {
  totalEaveLF: number;
  rakeCount: number;
  downspoutCount: number;
  theme: CanvasTheme;
}) {
  const tactical = theme === "tactical";
  return (
    <div
      className={cn(
        "absolute right-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs shadow-card backdrop-blur",
        tactical
          ? "border-cyan-500/30 bg-slate-950/80 text-cyan-100"
          : "border-zinc-200 bg-white/95 text-zinc-700",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-2 w-4 rounded-full",
            tactical
              ? "bg-cyan-400 shadow-[0_0_8px_rgba(0,229,255,0.95)]"
              : "bg-accent-500 shadow-[0_1px_3px_rgba(5,150,105,0.5)]",
          )}
        />
        Eaves
        <span
          className={cn(
            "font-semibold tabular-nums",
            tactical ? "text-white" : "text-zinc-900",
          )}
        >
          {totalEaveLF} LF
        </span>
      </div>
      {rakeCount > 0 && (
        <>
          <div
            className={cn(
              "h-4 w-px",
              tactical ? "bg-cyan-500/30" : "bg-zinc-200",
            )}
          />
          <div
            className="flex items-center gap-1.5"
            title="Rakes — sloped roof edges with no gutter, dashed gray on the canvas"
          >
            <span
              className={cn(
                "inline-flex h-0.5 w-4",
                tactical ? "bg-slate-400" : "bg-slate-500",
              )}
              style={{
                backgroundImage:
                  "repeating-linear-gradient(to right, currentColor 0 4px, transparent 4px 7px)",
              }}
            />
            <span className={tactical ? "text-slate-300" : "text-slate-600"}>
              Rakes
            </span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                tactical ? "text-slate-200" : "text-slate-700",
              )}
            >
              {rakeCount}
            </span>
          </div>
        </>
      )}
      <div className={cn("h-4 w-px", tactical ? "bg-cyan-500/30" : "bg-zinc-200")} />
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            tactical
              ? "bg-fuchsia-400 shadow-[0_0_8px_rgba(255,43,214,0.95)]"
              : "bg-cyan-600",
          )}
        />
        Downspouts
        <span
          className={cn(
            "font-semibold tabular-nums",
            tactical ? "text-white" : "text-zinc-900",
          )}
        >
          {downspoutCount}
        </span>
      </div>
      <div
        className={cn(
          "hidden h-4 w-px sm:block",
          tactical ? "bg-cyan-500/30" : "bg-zinc-200",
        )}
      />
      <div
        className={cn(
          "hidden items-center gap-1.5 sm:flex",
          tactical ? "text-cyan-200/70" : "text-zinc-500",
        )}
      >
        <Ruler className="h-3 w-3" />
        Scale 1:240
      </div>
      <button
        title="Fit to view"
        className={cn(
          "ml-1 rounded-md border p-1 transition",
          tactical
            ? "border-cyan-500/30 text-cyan-200/70 hover:border-cyan-400/60 hover:text-cyan-100"
            : "border-zinc-200 text-zinc-500 hover:border-accent-400 hover:text-accent-700",
        )}
      >
        <Maximize2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function LineLabel({
  line,
  theme,
  emphasized = false,
  animationDelay = 0,
  outsideAnchor,
  renderScale = 1,
}: {
  line: EditableLine;
  theme: CanvasTheme;
  /** Selected eaves render a larger label; non-selected render a compact pill. */
  emphasized?: boolean;
  animationDelay?: number;
  /** Reference point that's INSIDE the roof outline. The label picks
   *  the perpendicular direction whose unit vector points AWAY from
   *  this anchor — so labels land OUTSIDE the roof polygon rather
   *  than on top of roof shingles. Pass the eaves' centroid. */
  outsideAnchor?: { x: number; y: number };
  /** view.width / VIEWBOX_W. We multiply the label's viewBox dims by
   *  this so it stays the same on-screen size at any zoom. Without
   *  this, a 60-unit-wide label balloons to fill the screen when the
   *  contractor zooms in to nudge an eave. */
  renderScale?: number;
}) {
  if (line.points.length < 2) return null;
  const a = line.points[0];
  const b = line.points[line.points.length - 1];
  const len = Math.round(lineLengthFt(line));

  const tactical = theme === "tactical";
  // All viewBox sizes scale with the current zoom so the label looks
  // the same on screen at any zoom. Floors keep the label readable at
  // extreme zoom-out without going invisible.
  const w = (emphasized ? 60 : 44) * renderScale;
  const h = (emphasized ? 20 : 16) * renderScale;
  const fontSize = (emphasized ? 11 : 10) * renderScale;

  // Offset perpendicular to the line so the pill sits OFF the eave.
  // Same scaling rule: at high zoom, fewer viewBox units = same
  // screen distance.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = Math.hypot(dx, dy) || 1;
  const offsetMag = (emphasized ? 28 : 22) * renderScale;
  const nx = (-dy / len2) * offsetMag;
  const ny = (dx / len2) * offsetMag;

  // Pick the perpendicular direction that points AWAY from the roof's
  // centroid. dot(normal, centroid→midpoint) > 0 means the unsigned
  // normal already points outward; otherwise flip. Falls back to the
  // canvas-center heuristic when no anchor is supplied.
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const anchor = outsideAnchor ?? { x: VIEWBOX_W / 2, y: VIEWBOX_H / 2 };
  const fromAnchorX = cx - anchor.x;
  const fromAnchorY = cy - anchor.y;
  const sign = fromAnchorX * nx + fromAnchorY * ny >= 0 ? 1 : -1;
  const labelCx = cx + nx * sign;
  const labelCy = cy + ny * sign;

  return (
    <motion.g
      pointerEvents="none"
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        delay: animationDelay,
        type: "spring",
        stiffness: 240,
        damping: 16,
      }}
    >
      <rect
        x={labelCx - w / 2}
        y={labelCy - h / 2}
        width={w}
        height={h}
        rx={emphasized ? 6 : 4}
        fill={tactical ? "rgba(2,6,23,0.88)" : "rgba(255,255,255,0.96)"}
        stroke={
          tactical
            ? emphasized
              ? "#67e8f9"
              : "rgba(103,232,249,0.6)"
            : "#0e7490"
        }
        strokeWidth={1}
        style={{
          filter: tactical
            ? "drop-shadow(0 0 4px rgba(0,229,255,0.4))"
            : undefined,
        }}
      />
      <text
        x={labelCx}
        y={labelCy + (emphasized ? 4 : 3.5)}
        textAnchor="middle"
        fill={tactical ? "#a5f3fc" : "#0e7490"}
        fontSize={fontSize}
        fontWeight={600}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {len} LF
      </text>
    </motion.g>
  );
}
