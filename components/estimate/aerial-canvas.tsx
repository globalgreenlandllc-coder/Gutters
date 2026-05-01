"use client";

import { useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MousePointer2,
  Plus,
  Trash2,
  Maximize2,
  Layers,
  Ruler,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditableLine, Downspout } from "@/lib/types";
import {
  AerialBackground,
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
}: {
  eaves: EditableLine[];
  downspouts: Downspout[];
  onEavesChange: (next: EditableLine[]) => void;
  onDownspoutsChange: (next: Downspout[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
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
          {
            id,
            kind: "eave",
            points: [drawing.start, drawing.end],
          },
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
    <div className="relative h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-900/60 shadow-card">
      <Toolbar
        tool={tool}
        setTool={setTool}
        canDelete={!!selectedId}
        onDelete={deleteSelected}
      />

      <Legend totalEaveLF={totalEaveLF} downspoutCount={downspouts.length} />

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
        <AerialBackground />

        {eaves.map((line) => {
          const isSelected = selectedId === line.id;
          const isHover = hoverId === line.id;
          return (
            <g key={line.id}>
              <motion.path
                d={pathFor(line)}
                stroke={isSelected ? "#22d3ee" : "#34d399"}
                strokeWidth={isSelected ? 5 : isHover ? 4.5 : 4}
                strokeLinecap="round"
                fill="none"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.7, ease: "easeOut" }}
                style={{
                  filter: isSelected
                    ? "drop-shadow(0 0 8px rgba(34,211,238,0.7))"
                    : "drop-shadow(0 0 6px rgba(52,211,153,0.55))",
                  cursor: "pointer",
                }}
                onPointerDown={(e) => {
                  if (tool !== "select") return;
                  e.stopPropagation();
                  setSelectedId(line.id);
                }}
                onPointerEnter={() => setHoverId(line.id)}
                onPointerLeave={() => setHoverId(null)}
              />
              {isSelected &&
                line.points.map((pt, i) => (
                  <circle
                    key={i}
                    cx={pt.x}
                    cy={pt.y}
                    r={7}
                    fill="#0a0d14"
                    stroke="#22d3ee"
                    strokeWidth={2.5}
                    style={{ cursor: "grab" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag({ kind: "vertex", lineId: line.id, index: i });
                    }}
                  />
                ))}
              {isSelected && <LineLabel line={line} />}
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
              <circle
                cx={d.x}
                cy={d.y}
                r={isSelected ? 12 : 9}
                fill="rgba(34,211,238,0.18)"
                stroke={isSelected ? "#22d3ee" : "rgba(34,211,238,0.7)"}
                strokeWidth={2}
              />
              <circle cx={d.x} cy={d.y} r={3.5} fill="#22d3ee" />
              {isSelected && (
                <text
                  x={d.x + 14}
                  y={d.y + 4}
                  className="fill-cyan-200"
                  fontSize="11"
                  fontWeight={600}
                >
                  ↓ {d.heightFt} ft
                </text>
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
            stroke="#34d399"
            strokeWidth="3"
            strokeDasharray="8 5"
            opacity="0.9"
          />
        )}
      </svg>

      <AnimatePresence>
        {selectedId && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2"
          >
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-ink-900/90 px-3 py-2 text-xs text-zinc-300 shadow-card backdrop-blur">
              <span className="rounded-full bg-cyan-400/15 px-2 py-0.5 text-cyan-300">
                Selected
              </span>
              <span>Drag handles to adjust · Delete to remove</span>
              <button
                onClick={deleteSelected}
                className="ml-1 rounded-full border border-white/10 px-2 py-0.5 text-zinc-300 transition hover:border-rose-400/40 hover:text-rose-300"
              >
                <Trash2 className="inline h-3 w-3" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Toolbar({
  tool,
  setTool,
  canDelete,
  onDelete,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const tools: { id: Tool; icon: typeof MousePointer2; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Select" },
    { id: "add-eave", icon: Plus, label: "Add eave" },
    { id: "add-downspout", icon: Layers, label: "Add downspout" },
  ];
  return (
    <div className="absolute left-4 top-4 z-10 flex flex-col gap-1 rounded-xl border border-white/10 bg-ink-900/80 p-1 shadow-card backdrop-blur-xl">
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id)}
          title={t.label}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition",
            tool === t.id
              ? "bg-accent-500/20 text-accent-300 ring-1 ring-inset ring-accent-400/30"
              : "hover:bg-white/[0.05] hover:text-white",
          )}
        >
          <t.icon className="h-4 w-4" />
        </button>
      ))}
      <div className="my-1 h-px w-full bg-white/10" />
      <button
        onClick={onDelete}
        disabled={!canDelete}
        title="Delete selection"
        className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function Legend({
  totalEaveLF,
  downspoutCount,
}: {
  totalEaveLF: number;
  downspoutCount: number;
}) {
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-ink-900/80 px-3 py-2 text-xs shadow-card backdrop-blur-xl">
      <div className="flex items-center gap-1.5 text-zinc-300">
        <span className="h-2 w-4 rounded-full bg-accent-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
        Eaves
        <span className="font-semibold text-zinc-100">{totalEaveLF} LF</span>
      </div>
      <div className="h-4 w-px bg-white/10" />
      <div className="flex items-center gap-1.5 text-zinc-300">
        <span className="h-2.5 w-2.5 rounded-full bg-cyan-400" />
        Downspouts
        <span className="font-semibold text-zinc-100">{downspoutCount}</span>
      </div>
      <div className="hidden h-4 w-px bg-white/10 sm:block" />
      <div className="hidden items-center gap-1.5 text-zinc-400 sm:flex">
        <Ruler className="h-3 w-3" />
        Scale 1:240
      </div>
      <button
        title="Fit to view"
        className="ml-1 rounded-md border border-white/10 p-1 text-zinc-400 hover:border-accent-400/40 hover:text-accent-300"
      >
        <Maximize2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function LineLabel({ line }: { line: EditableLine }) {
  if (line.points.length < 2) return null;
  const a = line.points[0];
  const b = line.points[line.points.length - 1];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const len = Math.round(lineLengthFt(line));
  return (
    <g pointerEvents="none">
      <rect
        x={mid.x - 30}
        y={mid.y - 26}
        width={60}
        height={20}
        rx={6}
        fill="#0a0d14"
        stroke="#22d3ee"
        strokeWidth={1}
        opacity={0.95}
      />
      <text
        x={mid.x}
        y={mid.y - 12}
        textAnchor="middle"
        className="fill-cyan-200"
        fontSize="11"
        fontWeight={600}
      >
        {len} LF
      </text>
    </g>
  );
}
