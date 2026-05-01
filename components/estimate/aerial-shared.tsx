"use client";

import { motion } from "framer-motion";
import type { Downspout, EditableLine } from "@/lib/types";

export const VIEWBOX_W = 900;
export const VIEWBOX_H = 580;
export const PX_PER_FT = 2.4;

export function AerialBackground() {
  return (
    <g aria-hidden>
      <defs>
        <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#bdcfa9" />
          <stop offset="100%" stopColor="#9bb086" />
        </linearGradient>
        <linearGradient id="roof-main" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9c8b7d" />
          <stop offset="100%" stopColor="#7a6c5f" />
        </linearGradient>
        <linearGradient id="roof-garage" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#988779" />
          <stop offset="100%" stopColor="#736556" />
        </linearGradient>
        <linearGradient id="driveway" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfcdc8" />
          <stop offset="100%" stopColor="#b8b6b1" />
        </linearGradient>
        <pattern id="shingle" width="14" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 6 L14 6" stroke="rgba(0,0,0,0.18)" />
        </pattern>
      </defs>

      <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="url(#grass)" />

      {Array.from({ length: 32 }).map((_, i) => {
        const x = (i % 8) * 120 + (Math.floor(i / 8) % 2) * 60;
        const y = Math.floor(i / 8) * 150 + 20;
        return (
          <circle
            key={`bush-${i}`}
            cx={x + 30}
            cy={y + 30}
            r={6 + (i % 4) * 2}
            fill="#83a368"
            opacity={0.55}
          />
        );
      })}

      <g opacity={0.75}>
        <ellipse cx={120} cy={80} rx={28} ry={24} fill="#7ea264" />
        <ellipse cx={780} cy={120} rx={36} ry={30} fill="#82a866" />
        <ellipse cx={830} cy={500} rx={42} ry={36} fill="#75985b" />
        <ellipse cx={70} cy={520} rx={32} ry={28} fill="#7ca263" />
      </g>

      <rect x={620} y={420} width={170} height={80} rx={2} fill="url(#driveway)" />
      <line
        x1={620}
        y1={460}
        x2={790}
        y2={460}
        stroke="rgba(255,255,255,0.45)"
        strokeDasharray="6 8"
      />

      <rect
        x={220}
        y={240}
        width={360}
        height={140}
        fill="url(#roof-main)"
        stroke="#5b4f44"
        strokeWidth={1}
      />
      <rect x={220} y={240} width={360} height={140} fill="url(#shingle)" />
      <line
        x1={400}
        y1={240}
        x2={400}
        y2={380}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={1.5}
      />

      <rect
        x={580}
        y={280}
        width={140}
        height={80}
        fill="url(#roof-garage)"
        stroke="#5b4f44"
        strokeWidth={1}
      />
      <rect x={580} y={280} width={140} height={80} fill="url(#shingle)" />
      <line
        x1={650}
        y1={280}
        x2={650}
        y2={360}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={1.5}
      />

      <rect
        x={320}
        y={200}
        width={160}
        height={42}
        fill="url(#roof-main)"
        stroke="#5b4f44"
        strokeWidth={1}
      />
      <rect x={320} y={200} width={160} height={42} fill="url(#shingle)" />

      <rect x={355} y={300} width={20} height={26} fill="#3d342c" stroke="rgba(0,0,0,0.4)" />
      <rect x={425} y={300} width={20} height={26} fill="#3d342c" stroke="rgba(0,0,0,0.4)" />
      <circle cx={400} cy={355} r={6} fill="#5a4d40" stroke="rgba(0,0,0,0.4)" />

      <rect x={150} y={400} width={70} height={50} rx={3} fill="#a59c8e" opacity={0.85} />
    </g>
  );
}

export function AerialReadonly({
  eaves,
  downspouts,
  className,
}: {
  eaves: EditableLine[];
  downspouts: Downspout[];
  className?: string;
}) {
  return (
    <div
      className={
        "relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 " +
        (className ?? "")
      }
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
        style={{ minHeight: 280 }}
      >
        <AerialBackground />
        {eaves.map((line) => (
          <motion.path
            key={line.id}
            d={pathFor(line)}
            stroke="#059669"
            strokeWidth={4}
            strokeLinecap="round"
            fill="none"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            style={{ filter: "drop-shadow(0 1px 4px rgba(5,150,105,0.45))" }}
          />
        ))}
        {downspouts.map((d) => (
          <g key={d.id}>
            <circle
              cx={d.x}
              cy={d.y}
              r={9}
              fill="white"
              stroke="#0e7490"
              strokeWidth={2}
            />
            <circle cx={d.x} cy={d.y} r={3.5} fill="#0e7490" />
          </g>
        ))}
      </svg>
    </div>
  );
}

export function pathFor(line: EditableLine) {
  if (line.points.length === 0) return "";
  const [first, ...rest] = line.points;
  return (
    `M ${first.x} ${first.y} ` +
    rest.map((p) => `L ${p.x} ${p.y}`).join(" ")
  );
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function lineLengthFt(line: EditableLine) {
  let total = 0;
  for (let i = 1; i < line.points.length; i++) {
    total += dist(line.points[i - 1], line.points[i]);
  }
  return total / PX_PER_FT;
}
