import Link from "next/link";
import { Container, SectionHeader, PillLink } from "./ui";

const POSTS = [
  {
    tag: "Takeoffs",
    date: "Feb 2, 2026",
    title: "The First AI Takeoff Built for Gutter Contractors",
    visual: (
      <div className="relative flex h-[180px] items-center justify-center overflow-hidden rounded-xl bg-[#1e3a8a]">
        <div className="absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:20px_20px]" />
        <svg viewBox="0 0 200 110" className="relative w-[190px]">
          <path
            d="M30 20 H120 V48 H170 V95 H30 Z"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <path
            d="M30 20 L52 42 L100 42 L120 20 M52 42 V72 L30 95 M52 72 L148 72 L170 48 M120 48 L148 72"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth="1.3"
            strokeDasharray="4 4"
            fill="none"
          />
          <path d="M30 103 H170" stroke="#fbbf24" strokeWidth="2" />
          <path d="M30 99v8M170 99v8" stroke="#fbbf24" strokeWidth="2" />
        </svg>
        <span className="absolute bottom-3 left-4 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-white/70">
          Sheet A-4 &middot; Roof Plan
        </span>
      </div>
    ),
  },
  {
    tag: "Guide",
    date: "Jan 16, 2026",
    title: "How to Quote a Hip Roof Without Climbing It",
    visual: (
      <div className="flex h-[180px] items-center justify-center rounded-xl bg-[#1c1a17]">
        <svg viewBox="0 0 160 90" className="w-[170px]">
          <path
            d="M14 62h132l-26-38H40z"
            fill="none"
            stroke="#faf8f4"
            strokeWidth="2"
          />
          <path d="M14 62l26-38M146 62l-26-38M52 62l28-38M108 62l-28-38" stroke="#57534b" strokeWidth="1.4" />
          <path d="M14 62h132" stroke="#60a5fa" strokeWidth="3" />
        </svg>
      </div>
    ),
  },
  {
    tag: "AI Measurement",
    date: "Jan 3, 2026",
    title: "Understanding Roof Geometry From the Sky",
    visual: (
      <div className="relative flex h-[180px] items-center justify-center overflow-hidden rounded-xl bg-[radial-gradient(90%_120%_at_50%_110%,#1e3a8a,#0b1026_70%)]">
        <div className="absolute inset-0 opacity-70 [background-image:radial-gradient(#fbbf24_1px,transparent_1.4px)] [background-size:22px_18px]" />
        <div className="relative h-16 w-24 rounded-md border-2 border-[#7ee2a8]/80" />
      </div>
    ),
  },
];

export function Insights() {
  return (
    <section id="insights" className="bg-[#faf8f4] py-24 md:py-32">
      <Container>
        <SectionHeader
          eyebrow="Insights"
          title={
            <>
              Intelligence from the
              <br />
              takeoff frontier
            </>
          }
          copy="Research, field studies, and market intelligence on AI measurement, remote estimating, and the economics of winning exterior work faster."
          action={<PillLink href="/sign-in" variant="outline">Explore Our Blog</PillLink>}
        />

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {POSTS.map((p) => (
            <Link
              key={p.title}
              href="/sign-in"
              className="group rounded-[20px] border border-[#e9e5dd] bg-white p-4 transition hover:border-[#cfc9bf]"
            >
              {p.visual}
              <div className="px-2 pb-2 pt-5">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#8a857c]">
                  {p.tag} &middot; {p.date}
                </p>
                <h3 className="mt-2 min-h-[52px] text-[16.5px] font-semibold leading-snug text-[#1c1a17]">
                  {p.title}
                </h3>
                <p className="mt-4 text-[13px] font-medium text-[#1c1a17]">
                  Read Now{" "}
                  <span className="inline-block transition group-hover:translate-x-0.5">
                    &rarr;
                  </span>
                </p>
              </div>
            </Link>
          ))}
        </div>
      </Container>
    </section>
  );
}
