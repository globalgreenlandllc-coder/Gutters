/**
 * Animated hero scene: rain falls on a hip roof, water runs along the gutter
 * into the downspout, while a dashed measuring trace draws along the eave
 * with a live "186 LF" tag. Pure SVG + CSS keyframes (see globals.css).
 */
export function HouseScene() {
  const drops = [
    { x: 150, d: "0s" },
    { x: 195, d: "0.5s" },
    { x: 240, d: "0.9s" },
    { x: 285, d: "0.2s" },
    { x: 330, d: "0.7s" },
    { x: 375, d: "1.1s" },
    { x: 420, d: "0.35s" },
    { x: 462, d: "0.85s" },
  ];
  return (
    <svg viewBox="0 0 600 340" className="w-full max-w-2xl">
      {/* rain */}
      <g stroke="#5563f6" strokeWidth="2.5" strokeLinecap="round" opacity="0.75">
        {drops.map((r) => (
          <line
            key={r.x}
            x1={r.x}
            y1="18"
            x2={r.x - 5}
            y2="34"
            className="anim-rain"
            style={{ animationDelay: r.d }}
          />
        ))}
      </g>

      {/* house body */}
      <rect x="160" y="160" width="280" height="120" fill="#ffffff" fillOpacity="0.92" stroke="#1c1a17" strokeWidth="2.5" />
      {/* door + windows */}
      <rect x="282" y="212" width="36" height="68" fill="none" stroke="#1c1a17" strokeWidth="2" />
      <circle cx="311" cy="248" r="2" fill="#1c1a17" />
      <rect x="192" y="192" width="44" height="36" fill="none" stroke="#1c1a17" strokeWidth="2" />
      <path d="M192 210h44M214 192v36" stroke="#1c1a17" strokeWidth="1.4" />
      <rect x="364" y="192" width="44" height="36" fill="none" stroke="#1c1a17" strokeWidth="2" />
      <path d="M364 210h44M386 192v36" stroke="#1c1a17" strokeWidth="1.4" />

      {/* hip roof */}
      <path d="M138 158 L212 92 L388 92 L462 158 Z" fill="#1c1a17" />
      <path d="M212 92 L388 92" stroke="#3a372f" strokeWidth="2" />

      {/* gutter run along the eave */}
      <rect x="132" y="156" width="336" height="10" rx="5" fill="#ffffff" stroke="#1c1a17" strokeWidth="2.5" />
      {/* downspout */}
      <rect x="450" y="166" width="10" height="116" rx="4" fill="#ffffff" stroke="#1c1a17" strokeWidth="2.5" />

      {/* water flowing: gutter -> corner -> downspout */}
      <path
        d="M140 161 H452 M455 170 V276"
        fill="none"
        stroke="#5563f6"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="10 14"
        className="anim-flow"
      />
      {/* splash at the outlet */}
      <g className="anim-splash">
        <circle cx="455" cy="288" r="7" fill="none" stroke="#5563f6" strokeWidth="2.5" />
      </g>
      <path d="M100 292 H520" stroke="#1c1a17" strokeWidth="2.5" strokeLinecap="round" />

      {/* measuring trace along the eave */}
      <path
        d="M140 186 H460"
        fill="none"
        stroke="#f97316"
        strokeWidth="2.5"
        strokeDasharray="900"
        className="anim-trace"
      />
      <path d="M140 178v16M460 178v16" stroke="#f97316" strokeWidth="2.5" />

      {/* floating LF tag */}
      <g className="anim-float">
        <rect x="242" y="120" width="116" height="30" rx="15" fill="#ffffff" stroke="#1c1a17" strokeWidth="2" />
        <circle cx="262" cy="135" r="4" fill="#f97316" />
        <text x="274" y="140" fontSize="14" fontWeight="700" fill="#1c1a17" fontFamily="var(--font-display), sans-serif">
          186 LF
        </text>
      </g>
    </svg>
  );
}

/** Compact plan-view roof with a looping trace — used in the Engine section. */
export function PlanTrace() {
  return (
    <svg viewBox="0 0 400 230" className="w-full">
      {/* footprint */}
      <path
        d="M70 50 H250 V95 H330 V190 H70 Z"
        fill="#ffffff"
        stroke="#d8d3ca"
        strokeWidth="2"
      />
      {/* derived skeleton: hips + ridge */}
      <path
        d="M70 50 L110 90 L210 90 L250 50 M110 90 L110 150 L70 190 M110 150 L250 150 M250 150 L290 135 L330 95 M250 150 L250 190 M210 90 L250 150"
        stroke="#cfc9bf"
        strokeWidth="1.4"
        strokeDasharray="4 5"
        fill="none"
      />
      {/* animated eave trace around the perimeter */}
      <path
        d="M70 50 H250 V95 H330 V190 H70 Z"
        fill="none"
        stroke="#5563f6"
        strokeWidth="3.5"
        strokeLinejoin="round"
        strokeDasharray="900"
        className="anim-trace"
      />
      {/* corner nodes */}
      {[
        [70, 50],
        [250, 50],
        [250, 95],
        [330, 95],
        [330, 190],
        [70, 190],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="5" fill="#ffffff" stroke="#1c1a17" strokeWidth="2" />
      ))}
      {/* downspout drops */}
      {[
        [70, 50],
        [330, 95],
        [70, 190],
        [250, 190],
      ].map(([x, y]) => (
        <circle key={`d${x}-${y}`} cx={x} cy={y} r="2.5" fill="#f97316" />
      ))}
    </svg>
  );
}
