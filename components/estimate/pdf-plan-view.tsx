"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Maximize2 } from "lucide-react";

import { VIEWBOX_W, VIEWBOX_H } from "./aerial-constants";
import { PdfPageImage } from "./pdf-page-image";

type Sheet = { pageIndex: number; label: string };

/**
 * "Exact copy of the roof": render the actual PDF sheet from the uploaded
 * plan set — the architect's real drawing — zoomable and pannable, with a
 * selector to flip to the right sheet (roof plan / foundation / elevation).
 * No AI reconstruction. The schematic trace + pricing live in the other
 * tabs; this is the ground-truth reference the contractor verifies against
 * (and the surface a manual takeoff will draw on next).
 */
export function PdfPlanView({
  planSource,
}: {
  planSource: {
    pdfUrl: string;
    pageIndex: number;
    pageCount?: number;
    sheets?: Sheet[];
  };
}) {
  const sheets = planSource.sheets ?? [];
  const pageCount =
    planSource.pageCount ??
    (sheets.length ? Math.max(...sheets.map((s) => s.pageIndex)) : undefined);

  const [page, setPage] = useState(planSource.pageIndex || 1);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState({ x: 0, y: 0, w: VIEWBOX_W, h: VIEWBOX_H });
  const svgRef = useRef<SVGSVGElement>(null);
  const pan = useRef<{ px: number; py: number; vx: number; vy: number } | null>(
    null,
  );

  const resetView = () => setView({ x: 0, y: 0, w: VIEWBOX_W, h: VIEWBOX_H });
  const goPage = (p: number) => {
    setPage(p);
    resetView();
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const cursorVX = view.x + fx * view.w;
    const cursorVY = view.y + fy * view.h;
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const minW = VIEWBOX_W / 10;
    const maxW = VIEWBOX_W * 6;
    const nextW = Math.max(minW, Math.min(maxW, view.w * factor));
    const nextH = nextW * (view.h / view.w);
    setView({
      x: cursorVX - fx * nextW,
      y: cursorVY - fy * nextH,
      w: nextW,
      h: nextH,
    });
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pan.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pan.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - pan.current.px) / rect.width) * view.w;
    const dy = ((e.clientY - pan.current.py) / rect.height) * view.h;
    setView((v) => ({ ...v, x: pan.current!.vx - dx, y: pan.current!.vy - dy }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pan.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const btn =
    "inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {sheets.length > 0 ? (
          <select
            value={page}
            onChange={(e) => goPage(Number(e.target.value))}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {sheets.map((s) => (
              <option key={s.pageIndex} value={s.pageIndex}>
                Page {s.pageIndex} · {s.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className={btn}
              disabled={page <= 1}
              onClick={() => goPage(Math.max(1, page - 1))}
            >
              <ChevronLeft size={13} />
            </button>
            <span className="px-1 font-medium text-zinc-600 dark:text-zinc-300">
              Page {page}
              {pageCount ? ` / ${pageCount}` : ""}
            </span>
            <button
              type="button"
              className={btn}
              disabled={pageCount != null && page >= pageCount}
              onClick={() =>
                goPage(pageCount ? Math.min(pageCount, page + 1) : page + 1)
              }
            >
              <ChevronRight size={13} />
            </button>
          </div>
        )}
        <button type="button" className={btn} onClick={resetView}>
          <Maximize2 size={13} /> Fit
        </button>
        <span className="text-zinc-400 dark:text-zinc-500">
          Actual sheet from your PDF — scroll to zoom, drag to pan.
        </span>
      </div>

      <div className="relative min-h-[520px] overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700">
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className="h-full w-full touch-none select-none"
          style={{ minHeight: 520, cursor: pan.current ? "grabbing" : "grab" }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <rect x={0} y={0} width={VIEWBOX_W} height={VIEWBOX_H} fill="#ffffff" />
          <PdfPageImage
            pdfUrl={planSource.pdfUrl}
            pageIndex={page}
            onState={setState}
          />
        </svg>

        {state === "loading" && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="inline-flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 size={16} className="animate-spin" /> Rendering sheet…
            </span>
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <p className="max-w-sm text-sm text-zinc-500">
              Couldn&apos;t render this sheet. It may be a scanned/raster PDF
              with no rendering layer, or the page is unavailable — try another
              sheet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
