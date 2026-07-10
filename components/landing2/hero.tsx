import { Container, Eyebrow, PillLink } from "./ui";
import { HouseScene } from "./house-scene";

/** Segmented pipeline control shown at the top of the hero showcase card. */
function PipelineTabs() {
  const tabs = ["Detection", "Measurement", "Pricing", "Proposal"];
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-white/60 bg-white/70 p-1 shadow-sm backdrop-blur">
      {tabs.map((t, i) => (
        <span
          key={t}
          className={
            i === 0
              ? "flex items-center gap-1.5 rounded-full bg-[#1c1a17] px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wide text-white"
              : "rounded-full px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wide text-[#57534b]"
          }
        >
          {i === 0 && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          )}
          {t}
        </span>
      ))}
    </div>
  );
}

function Token({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "blue" | "orange" | "green";
}) {
  const tones = {
    blue: "bg-[#e8ecff] text-[#2e40e8]",
    orange: "bg-[#ffedd5] text-[#c2410c]",
    green: "bg-[#dcfce7] text-[#15803d]",
  } as const;
  return (
    <span className={`mx-0.5 rounded-md px-1.5 py-0.5 font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ShowcaseCard() {
  return (
    <div className="relative mt-14 overflow-hidden rounded-[28px] bg-[radial-gradient(120%_140%_at_15%_0%,#fef3e2_0%,#fcd9c0_32%,#f9b8c4_62%,#c9b8f2_100%)] px-5 pb-14 pt-8 md:px-12 md:pb-16 md:pt-10">
      {/* soft glow blobs */}
      <div className="pointer-events-none absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-white/40 blur-3xl" />
      <div className="pointer-events-none absolute -right-16 -top-16 h-72 w-72 rounded-full bg-[#ffd9a8]/60 blur-3xl" />

      <div className="relative flex justify-center">
        <PipelineTabs />
      </div>

      <div className="relative mt-8 grid items-center gap-8 md:grid-cols-[1.05fr_0.95fr] md:gap-12">
        <div className="flex justify-center">
          <HouseScene />
        </div>

        <div className="rounded-2xl border border-white/70 bg-white/90 p-6 shadow-[0_24px_60px_-24px_rgba(120,60,40,0.35)] backdrop-blur md:p-7">
          <p className="text-[14px] leading-[1.9] text-[#3a372f] md:text-[15px]">
            A homeowner at <Token tone="blue">1425 Maple Ave</Token> requests a
            gutter quote. GutterScan traces the roofline from aerial imagery
            with <Token tone="green">94% confidence</Token>, measures the eave
            run at <Token tone="orange">186 LF</Token>, and prices it as{" "}
            <Token tone="blue">5&quot; K-Style &middot; $12.50/LF</Token>.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-[#1c1a17] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white">
              Preview
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            {["Roof Trace", "8 Downspouts", "2 Stories", "$2,325 Estimate"].map(
              (chip) => (
                <span
                  key={chip}
                  className="rounded-full border border-[#e5e0d6] bg-white px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-[#57534b]"
                >
                  {chip}
                </span>
              ),
            )}
          </div>
        </div>
      </div>

      <p className="absolute bottom-5 right-7 font-mono text-[10px] font-bold uppercase tracking-wide text-[#7a4a3a]/70">
        Powered by Gutterscan &#9632;
      </p>
    </div>
  );
}

export function Hero() {
  return (
    <section className="pb-10 pt-14 md:pt-20">
      <Container>
        <Eyebrow>AI Takeoff Intelligence</Eyebrow>
        <div className="mt-6 grid gap-10 md:grid-cols-[1.4fr_0.6fr] md:items-start md:gap-12">
          <h1 className="font-display text-[34px] uppercase leading-[0.95] tracking-[-0.015em] text-[#1c1a17] md:text-[56px]">
            Where addresses
            <br />
            become estimates.
          </h1>
          <div className="max-w-sm md:justify-self-end md:pt-3">
            <p className="text-[15px] leading-relaxed text-[#6e6a62]">
              The measurement intelligence layer for gutter contractors.
              Delivering accurate takeoffs and winning proposals from aerial
              imagery and blueprints &mdash; no ladder required.
            </p>
            <div className="mt-6 flex items-center gap-3">
              <PillLink href="/sign-in">Get Started</PillLink>
              <PillLink href="/sign-in" variant="outline">
                Contact Sales
              </PillLink>
            </div>
          </div>
        </div>

        <ShowcaseCard />
      </Container>
    </section>
  );
}
