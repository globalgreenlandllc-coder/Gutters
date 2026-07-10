import { Container, SectionHeader } from "./ui";
import Link from "next/link";

function SpecTable() {
  const rows = [
    ["Imagery", "Aerial + Blueprint"],
    ["Roofline confidence", "94%"],
    ["Profile", '5" K-Style Aluminum'],
    ["Rate", "$12.50 / LF"],
  ];
  return (
    <div className="mt-8 divide-y divide-[#f0ede6] rounded-xl border border-[#e9e5dd] bg-white">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between px-4 py-3 text-[13px]">
          <span className="text-[#8a857c]">{k}</span>
          <span className="font-medium text-[#1c1a17]">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Dark card: technical cross-section of a K-style gutter, shop-drawing style. */
function ProfileCard() {
  return (
    <div className="relative flex flex-col justify-between overflow-hidden rounded-[24px] bg-[#1c1a17] p-7">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#8a857c]">
          Inside the geometry engine
        </p>
        <span className="rounded-full border border-[#33302b] px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-wide text-[#8a857c]">
          Section A&ndash;A
        </span>
      </div>

      <svg viewBox="0 0 400 300" className="my-4 w-full">
        {/* width dimension */}
        <text x="196" y="46" textAnchor="middle" fill="#f97316" fontSize="11" fontFamily="var(--font-mono), monospace" fontWeight="700">
          5 IN
        </text>
        <path d="M130 58 H172 M220 58 H262" stroke="#f97316" strokeWidth="1.5" />
        <path d="M130 52v12M262 52v12" stroke="#f97316" strokeWidth="1.5" />
        <text x="196" y="62" textAnchor="middle" fill="#f97316" fontSize="9" fontFamily="var(--font-mono), monospace">
          &#8596;
        </text>

        {/* height dimension */}
        <path d="M100 80 V225" stroke="#f97316" strokeWidth="1.5" />
        <path d="M94 80h12M94 225h12" stroke="#f97316" strokeWidth="1.5" />
        <text
          x="88"
          y="156"
          fill="#f97316"
          fontSize="11"
          fontFamily="var(--font-mono), monospace"
          fontWeight="700"
          transform="rotate(-90 88 156)"
          textAnchor="middle"
        >
          4 IN
        </text>

        {/* K-style profile: back wall, bottom, ogee face, curled lip */}
        <path
          d="M130 80 V225 H235 C260 225 268 200 252 185 C238 172 240 158 258 146 C276 134 280 112 262 100 L254 96"
          fill="none"
          stroke="#faf8f4"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray="900"
          className="anim-trace"
        />
        {/* hanger */}
        <path d="M132 102 H256" stroke="#57534b" strokeWidth="2" strokeDasharray="5 5" />
        <circle cx="134" cy="102" r="3" fill="#57534b" />
        <circle cx="254" cy="102" r="3" fill="#57534b" />

        {/* water in the trough */}
        <path d="M142 212 H226" stroke="#5563f6" strokeWidth="11" strokeLinecap="round" opacity="0.3" />
        <path
          d="M142 212 H226"
          stroke="#5563f6"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="8 10"
          className="anim-flow"
        />

        {/* leader labels */}
        <path d="M262 100 L318 90" stroke="#57534b" strokeWidth="1" />
        <text x="322" y="93" fill="#a8a29a" fontSize="10" fontFamily="var(--font-mono), monospace">
          LIP
        </text>
        <path d="M252 180 L318 180" stroke="#57534b" strokeWidth="1" />
        <text x="322" y="183" fill="#a8a29a" fontSize="10" fontFamily="var(--font-mono), monospace">
          OGEE
        </text>
        <path d="M184 212 L184 252 L232 252" stroke="#57534b" strokeWidth="1" />
        <text x="236" y="255" fill="#a8a29a" fontSize="10" fontFamily="var(--font-mono), monospace">
          FLOW 186 LF
        </text>

        {/* title block */}
        <text x="130" y="282" fill="#8a857c" fontSize="10" fontFamily="var(--font-mono), monospace" fontWeight="700" letterSpacing="2">
          K-STYLE &middot; ALUM .032 &middot; SEAMLESS
        </text>
      </svg>

      <div className="flex justify-end">
        <Link
          href="/sign-in"
          className="inline-flex h-10 items-center rounded-full bg-white px-5 text-[13px] font-medium text-[#1c1a17] transition hover:bg-[#f1ede6]"
        >
          Explore the Engine
        </Link>
      </div>
    </div>
  );
}

export function Detection() {
  return (
    <section id="engine" className="bg-white py-24 md:py-32">
      <Container>
        <SectionHeader
          eyebrow="Measurement Intelligence"
          title={
            <>
              From detection to
              <br />
              signed proposal
            </>
          }
          copy="Our geometry engine finds the footprint, classifies every roofline segment as eave or rake, and maps measured lengths to your own pricing — tiers, materials, and margins included."
        />

        <div className="mt-14 grid gap-4 md:grid-cols-2">
          <div className="rounded-[24px] border border-[#e9e5dd] bg-[#faf8f4] p-7 md:p-9">
            <h3 className="font-display text-[22px] uppercase leading-tight text-[#1c1a17] md:text-[26px]">
              Detect. Measure. Price.
            </h3>
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-[#6e6a62]">
              Real-time takeoff for any address or plan set &mdash; footprint
              tracing, eave-vs-rake classification, and line-item pricing in
              one flow.
            </p>
            <SpecTable />
          </div>
          <ProfileCard />
        </div>
      </Container>
    </section>
  );
}
