"use client";

import { useEffect, useRef, useState } from "react";
import { Eraser, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";

export function SignaturePad({
  value,
  onChange,
  signerName,
  onSignerName,
}: {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  signerName: string;
  onSignerName: (n: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [hasInk, setHasInk] = useState(!!value);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = "#14688C";
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
  }, []);

  function getPos(e: React.PointerEvent): { x: number; y: number } {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e: React.PointerEvent) {
    const c = canvasRef.current;
    if (!c) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const p = getPos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setDrawing(true);
    setHasInk(true);
  }

  function move(e: React.PointerEvent) {
    if (!drawing) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const p = getPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function up(e: React.PointerEvent) {
    const c = canvasRef.current;
    if (!c) return;
    setDrawing(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    onChange(c.toDataURL());
  }

  function clear() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between">
        <label className="font-label text-[11px] text-zinc-500">
          Signature
        </label>
        <button
          type="button"
          onClick={clear}
          disabled={!hasInk}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition hover:border-rose-300 hover:text-rose-600 disabled:opacity-40"
        >
          <Eraser className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div
        className={cn(
          "relative mt-2 overflow-hidden rounded-xl border bg-zinc-50/40 transition",
          hasInk ? "border-accent-300" : "border-zinc-200",
        )}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          className="block h-44 w-full touch-none cursor-crosshair"
        />
        {!hasInk && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-zinc-400">
            <PenLine className="h-4 w-4" />
            <span className="text-sm">Sign here</span>
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 left-3 right-3 border-t border-dashed border-zinc-300" />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <label className="font-label text-[11px] text-zinc-500">
          Print name
        </label>
        <input
          value={signerName}
          onChange={(e) => onSignerName(e.target.value)}
          placeholder="Your full name"
          className="h-9 flex-1 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/15"
        />
      </div>
    </div>
  );
}
