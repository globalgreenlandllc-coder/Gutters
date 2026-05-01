"use client";

import { ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Photo } from "@/lib/proposal-mock";

const TONES: Record<
  Photo["tone"],
  { from: string; via: string; to: string; accent: string }
> = {
  front: {
    from: "#1a2535",
    via: "#26344a",
    to: "#0e1421",
    accent: "#34d399",
  },
  side: {
    from: "#221a14",
    via: "#3a2d22",
    to: "#10100c",
    accent: "#f59e0b",
  },
  back: {
    from: "#15281b",
    via: "#1f3a26",
    to: "#0a1410",
    accent: "#22d3ee",
  },
  detail: {
    from: "#2a1419",
    via: "#3f2026",
    to: "#170c10",
    accent: "#f472b6",
  },
};

export function PhotoTile({
  photo,
  className,
}: {
  photo: Photo;
  className?: string;
}) {
  const t = TONES[photo.tone];
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-white/10",
        className,
      )}
      style={{
        background: `linear-gradient(135deg, ${t.from} 0%, ${t.via} 50%, ${t.to} 100%)`,
      }}
    >
      <svg
        viewBox="0 0 200 140"
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
      >
        <defs>
          <linearGradient id={`g-${photo.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.accent} stopOpacity="0.15" />
            <stop offset="100%" stopColor={t.accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="160" cy="30" r="40" fill={`url(#g-${photo.id})`} />
        <path
          d="M0 110 Q 50 90 100 105 T 200 100 V140 H0 Z"
          fill="rgba(0,0,0,0.25)"
        />
        <path
          d="M40 80 L 100 50 L 160 80 L 160 110 L 40 110 Z"
          fill="rgba(0,0,0,0.35)"
          stroke="rgba(255,255,255,0.05)"
        />
        <rect
          x="80"
          y="80"
          width="14"
          height="20"
          fill="rgba(0,0,0,0.5)"
        />
        <line
          x1="40"
          y1="80"
          x2="160"
          y2="80"
          stroke={t.accent}
          strokeWidth="1.5"
          strokeOpacity="0.6"
        />
      </svg>
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-full border border-white/15 bg-black/40 px-2 py-0.5 text-[10px] text-zinc-200 backdrop-blur">
        <ImageIcon className="h-2.5 w-2.5" />
        Photo
      </div>
      <div className="absolute inset-x-2 bottom-2 text-xs font-medium text-zinc-100 drop-shadow">
        {photo.caption}
      </div>
    </div>
  );
}
