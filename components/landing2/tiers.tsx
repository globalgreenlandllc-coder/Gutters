import Link from "next/link";
import { Container, SectionHeader } from "./ui";

/** Small K-style / half-round profile strokes drawn per tier. */
function KStyleGlyph({ stroke, guard }: { stroke: string; guard?: string }) {
  return (
    <svg viewBox="0 0 160 90" className="w-[132px]">
      <path
        d="M42 14 V70 H96 C112 70 117 55 107 46 C98 38 100 29 111 23 C122 17 123 8 112 4"
        fill="none"
        stroke={stroke}
        strokeWidth="5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {guard ? (
        <path d="M40 10 L114 2" stroke={guard} strokeWidth="3" strokeDasharray="6 5" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

function HalfRoundGlyph() {
  return (
    <svg viewBox="0 0 160 90" className="w-[132px]">
      <defs>
        <linearGradient id="copper" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#e0955e" />
          <stop offset="55%" stopColor="#c97a44" />
          <stop offset="100%" stopColor="#8a4f2d" />
        </linearGradient>
      </defs>
      <path
        d="M34 22 C34 74 126 74 126 22"
        fill="none"
        stroke="url(#copper)"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="34" cy="20" r="6" fill="none" stroke="url(#copper)" strokeWidth="4" />
      <circle cx="126" cy="20" r="6" fill="none" stroke="url(#copper)" strokeWidth="4" />
    </svg>
  );
}

const TIERS = [
  {
    name: "good",
    visual: (
      <div className="relative flex h-[190px] items-center justify-center rounded-xl bg-[#f5d93f] p-5">
        <span className="absolute right-4 top-4 font-mono text-[9px] font-bold uppercase tracking-wide text-[#1c1a17]/60">
          5&quot; K-Style
        </span>
        <KStyleGlyph stroke="#1c1a17" />
        <p className="absolute bottom-4 left-5 font-display text-[26px] uppercase tracking-tight text-[#1c1a17]">
          Good
        </p>
      </div>
    ),
    title: "Dependable, priced to win",
    body: '5" K-style aluminum in the standard palette. The measured baseline bid that beats every flat quote on the street.',
  },
  {
    name: "better",
    visual: (
      <div className="relative flex h-[190px] items-center justify-center rounded-xl bg-[radial-gradient(120%_130%_at_20%_0%,#5b4ee8,#2a1a6e_70%)] p-5">
        <span className="absolute right-4 top-4 font-mono text-[9px] font-bold uppercase tracking-wide text-white/60">
          6&quot; Seamless + Guard
        </span>
        <KStyleGlyph stroke="#ffffff" guard="#a5b4fc" />
        <p className="absolute bottom-4 left-5 font-display text-[26px] uppercase tracking-tight text-white">
          Better<span className="text-[#a5b4fc]">+</span>
        </p>
      </div>
    ),
    title: "The upgrade most homes choose",
    body: '6" seamless with oversized downspouts and leaf guards on the worst runs. Bigger water, fewer callbacks.',
  },
  {
    name: "best",
    visual: (
      <div className="relative flex h-[190px] items-center justify-center rounded-xl bg-[radial-gradient(120%_130%_at_80%_0%,#7f1d1d,#1c1a17_75%)] p-5">
        <span className="absolute right-4 top-4 font-mono text-[9px] font-bold uppercase tracking-wide text-[#fda374]/70">
          Copper Half-Round
        </span>
        <HalfRoundGlyph />
        <p className="absolute bottom-4 left-5 font-display text-[26px] uppercase tracking-tight text-[#fda374]">
          Best
        </p>
      </div>
    ),
    title: "Premium metal & full protection",
    body: "Copper or designer steel, hidden hangers, guards on every foot. For the homeowner who asks for the top line.",
  },
];

export function Tiers() {
  return (
    <section id="proposals" className="bg-white py-24 md:py-32">
      <Container>
        <SectionHeader
          eyebrow="Premium Proposals"
          title={
            <>
              Curated tiers for
              <br />
              high-intent homeowners
            </>
          }
          copy="Measured roofs command confident pricing. Every proposal ships with three tiers built from your own materials and margins — no guesswork, no race to the bottom."
        />

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className="rounded-[20px] border border-[#e9e5dd] bg-white p-4"
            >
              {t.visual}
              <div className="px-2 pb-2 pt-5">
                <h3 className="text-[16px] font-semibold text-[#1c1a17]">
                  {t.title}
                </h3>
                <p className="mt-2 min-h-[60px] text-[13.5px] leading-relaxed text-[#8a857c]">
                  {t.body}
                </p>
                <div className="mt-4 flex items-center justify-between">
                  <Link
                    href="/sign-in"
                    className="inline-flex h-9 items-center rounded-full bg-[#1c1a17] px-4 text-[12.5px] font-medium text-white transition hover:bg-[#33302b]"
                  >
                    View Sample
                  </Link>
                  <span className="text-[12px] text-[#b3ada2]">
                    Why this tier?
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
