"use client";

import { useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2,
  Layers,
  Maximize2,
  MountainSnow,
  MousePointer2,
  Plus,
  Ruler,
  Sparkles,
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
  downspouts,
  onEavesChange,
  onDownspoutsChange,
  aerialImageUrl,
  roofStructure,
}: {
  eaves: EditableLine[];
  downspouts: Downspout[];
  onEavesChange: (next: EditableLine[]) => void;
  onDownspoutsChange: (next: Downspout[]) => void;
  aerialImageUrl?: string;
  roofStructure?: RoofStructure;
}) {
  const [theme, setTheme] = useState<CanvasTheme>("tactical");
  const t = THEMES[theme];
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [showRoofStructure, setShowRoofStructure] = useState(true);
  const [drag, setDrag] = useState<
    | { kind: "vertex"; lineId: string; index: number }
    | { kind: "downspout"; id: string }
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

  const selectedDownspout = useMemo(
    () => downspouts.find((d) => d.id === selectedId) ?? null,
    [downspouts, selectedId],
  );

  function svgPoint(e: React.PointerEvent): { x: number; y: number } {
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

  function handlePointerDown(e: React.PointerEvent) {
    const p = svgPoint(e);
    if (tool === "add-eave") {
      setDrawing({ start: p, end: p });
      e.currentTarget.setPointerCapture(e.pointerId);
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
    if (drawing) {
      setDrawing({ ...drawing, end: p });
      return;
    }
    if (drag?.kind === "vertex") {
      onEavesChange(
        eaves.map((l) =>
          l.id === drag.lineId
            ? {
                ...l,
                points: l.points.map((pt, i) => (i === drag.index ? p : pt)),
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

  function handlePointerUp(e: React.PointerEvent) {
    if (drawing) {
      const len = dist(drawing.start, drawing.end);
      if (len > 14) {
        const id = `eave-${Date.now()}`;
        onEavesChange([
          ...eaves,
          { id, kind: "eave", points: [drawing.start, drawing.end] },
        ]);
        setSelectedId(id);
      }
      setDrawing(null);
      setTool("select");
      e.currentTarget.releasePointerCapture(e.pointerId);
      return;
    }
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

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-2xl border shadow-card transition-colors",
        theme === "tactical"
          ? "border-cyan-900/40 bg-slate-950"
          : "border-zinc-200 bg-zinc-100",
      )}
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
      />
      <Legend
        totalEaveLF={totalEaveLF}
        downspoutCount={downspouts.length}
        theme={theme}
      />
      {roofStructure && showRoofStructure && (
        <RoofStructureBanner confidence={roofStructure.confidence} />
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid slice"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={cn(
          "h-full w-full touch-none select-none",
          tool === "add-eave" && "cursor-crosshair",
          tool === "add-downspout" && "cursor-copy",
        )}
        style={{ minHeight: 420 }}
      >
        <NeonDefs />
        {aerialImageUrl ? (
          <AerialImage imageDataUrl={aerialImageUrl} />
        ) : (
          <AerialBackground />
        )}
        {t.overlay && (
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

        {eaves.map((line, i) => {
          const isSelected = selectedId === line.id;
          const isHover = hoverId === line.id;
          const stroke = isSelected ? t.eaveSelected : t.eave;
          const filter =
            theme === "tactical"
              ? isSelected
                ? "drop-shadow(0 0 10px rgba(0,229,255,1))"
                : "drop-shadow(0 0 6px rgba(0,229,255,0.95))"
              : isSelected
                ? "drop-shadow(0 1px 6px rgba(14,116,144,0.55))"
                : "drop-shadow(0 1px 4px rgba(5,150,105,0.45))";
          return (
            <g key={line.id}>
              <motion.path
                d={pathFor(line)}
                stroke={stroke}
                strokeWidth={isSelected ? 5 : isHover ? 4 : 3}
                strokeLinecap="round"
                fill="none"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{
                  duration: 0.7,
                  ease: "easeOut",
                  delay: i * 0.05,
                }}
                style={{ filter, cursor: "pointer" }}
                onPointerDown={(e) => {
                  if (tool !== "select") return;
                  e.stopPropagation();
                  setSelectedId(line.id);
                }}
                onPointerEnter={() => setHoverId(line.id)}
                onPointerLeave={() => setHoverId(null)}
              />
              {isSelected &&
                line.points.map((pt, idx) => (
                  <circle
                    key={idx}
                    cx={pt.x}
                    cy={pt.y}
                    r={7}
                    fill={t.handleFill}
                    stroke={t.handleStroke}
                    strokeWidth={2.5}
                    style={{ cursor: "grab" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag({ kind: "vertex", lineId: line.id, index: idx });
                    }}
                  />
                ))}
              <LineLabel
                line={line}
                theme={theme}
                emphasized={isSelected}
                animationDelay={0.6 + i * 0.06}
              />
            </g>
          );
        })}

        {downspouts.map((d, i) => {
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
              {theme === "tactical" ? (
                <>
                  <motion.circle
                    cx={d.x}
                    cy={d.y}
                    r={isSelected ? 18 : 14}
                    fill={t.downspout}
                    opacity={0.18}
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{
                      scale: [0.7, 1.3, 0.9],
                      opacity: [0, 0.4, 0.18],
                    }}
                    transition={{
                      duration: 2.2,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: i * 0.15,
                    }}
                    pointerEvents="none"
                  />
                  <circle
                    cx={d.x}
                    cy={d.y}
                    r={isSelected ? 8 : 6}
                    fill={t.downspout}
                    filter={t.downspoutGlowFilter ?? undefined}
                  />
                  <circle cx={d.x} cy={d.y} r={2.4} fill={t.downspoutCore} />
                </>
              ) : (
                <>
                  <circle
                    cx={d.x}
                    cy={d.y}
                    r={isSelected ? 12 : 9}
                    fill="white"
                    stroke={
                      isSelected ? t.downspout : "rgba(14,116,144,0.85)"
                    }
                    strokeWidth={2}
                  />
                  <circle cx={d.x} cy={d.y} r={3.5} fill={t.downspoutCore} />
                </>
              )}
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
            strokeWidth="3"
            strokeDasharray="8 5"
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
}: {
  downspout: Downspout;
  theme: CanvasTheme;
  onChangeStories: (s: Stories) => void;
  onDelete: () => void;
}) {
  const current = storiesFromHeightFt(downspout.heightFt);
  const options: { id: Stories; label: string; ft: number }[] = [
    { id: 1, label: "1-story", ft: 10 },
    { id: 2, label: "2-story", ft: 20 },
    { id: 3, label: "3-story", ft: 30 },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className="absolute bottom-4 left-1/2 -translate-x-1/2"
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
          className={cn(
            "ml-1 rounded-full border px-2 py-1 transition",
            theme === "tactical"
              ? "border-fuchsia-500/30 hover:border-rose-400 hover:text-rose-300"
              : "border-zinc-200 hover:border-rose-300 hover:text-rose-600",
          )}
        >
          <Trash2 className="inline h-3 w-3" />
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
            "flex h-9 w-9 items-center justify-center rounded-lg transition",
            tool === t.id
              ? tactical
                ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-inset ring-cyan-400/50"
                : "bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200"
              : tactical
                ? "text-cyan-200/70 hover:bg-cyan-500/10 hover:text-cyan-100"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          <t.icon className="h-4 w-4" />
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
        <span>Perimeter</span>
        <span className="mx-1 h-3 w-px bg-white/25" />
        <span className="rounded px-1.5 py-0.5 bg-blue-700/80 uppercase tracking-wider text-[10px]">
          Ridge
        </span>
        <span className="rounded px-1.5 py-0.5 bg-emerald-700/80 uppercase tracking-wider text-[10px]">
          Valley
        </span>
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
  downspoutCount,
  theme,
}: {
  totalEaveLF: number;
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
}: {
  line: EditableLine;
  theme: CanvasTheme;
  /** Selected eaves render a larger label; non-selected render a compact pill. */
  emphasized?: boolean;
  animationDelay?: number;
}) {
  if (line.points.length < 2) return null;
  const a = line.points[0];
  const b = line.points[line.points.length - 1];
  const len = Math.round(lineLengthFt(line));

  // Skip the always-on label for tiny segments — they'd visually clutter
  // the perimeter without adding info. Selected segments still show.
  if (!emphasized && len < 6) return null;

  const tactical = theme === "tactical";
  const w = emphasized ? 60 : 44;
  const h = emphasized ? 20 : 16;
  const fontSize = emphasized ? 11 : 10;

  // Offset the label perpendicular to the line so it sits OFF the eave
  // rather than crossing it. For mostly-horizontal lines, lift it up; for
  // mostly-vertical lines, push it sideways.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = Math.hypot(dx, dy) || 1;
  const offsetMag = emphasized ? 16 : 12;
  const nx = (-dy / len2) * offsetMag;
  const ny = (dx / len2) * offsetMag;

  // Always offset toward the "inside" of the canvas so labels don't escape
  // the viewBox on roof corners near the edges of the image.
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const towardCenter = (cx - VIEWBOX_W / 2) * nx + (cy - VIEWBOX_H / 2) * ny;
  const sign = towardCenter > 0 ? -1 : 1;
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
