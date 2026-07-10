import { Container, PillLink } from "./ui";

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" />
    </svg>
  );
}

export function CTA() {
  return (
    <section className="px-3 pb-3">
      <div className="relative overflow-hidden rounded-[28px] bg-[#e9f0e2] py-24 md:py-32">
        <Sparkle className="anim-float absolute left-[8%] top-12 h-8 w-8 text-[#8fae7e]" />
        <Sparkle className="anim-float absolute bottom-14 right-[9%] h-10 w-10 text-[#f2b23e] [animation-delay:0.8s]" />
        <Sparkle className="anim-float absolute bottom-24 left-[16%] h-4 w-4 text-[#c3d3b6] [animation-delay:1.6s]" />
        {/* light rain over the CTA */}
        <svg
          viewBox="0 0 600 120"
          className="pointer-events-none absolute inset-x-0 top-0 w-full opacity-60"
          preserveAspectRatio="none"
        >
          <g stroke="#5563f6" strokeWidth="2" strokeLinecap="round">
            {[60, 150, 260, 340, 430, 540].map((x, i) => (
              <line
                key={x}
                x1={x}
                y1="0"
                x2={x - 4}
                y2="14"
                className="anim-rain"
                style={{ animationDelay: `${i * 0.28}s` }}
              />
            ))}
          </g>
        </svg>
        <Container className="text-center">
          <h2 className="mx-auto max-w-2xl font-display text-[32px] uppercase leading-[1] text-[#1c1a17] md:text-[46px]">
            Ready to activate your AI takeoffs?
          </h2>
          <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-[#6e6a62]">
            Join contractors winning measured, three-tier bids from the
            fastest-growing estimating engine in exteriors.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <PillLink href="/sign-in">Get Started</PillLink>
            <PillLink href="/sign-in" variant="outline" className="border-[#c3d3b6]">
              Contact Sales
            </PillLink>
          </div>
        </Container>
      </div>
    </section>
  );
}
