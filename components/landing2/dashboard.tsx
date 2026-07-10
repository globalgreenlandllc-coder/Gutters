import { Container, SectionHeader } from "./ui";

const TABS = [
  { label: "Aerial", dot: "#f97316", active: true },
  { label: "Blueprint", dot: "#60a5fa", active: false },
  { label: "Manual", dot: "#34d399", active: false },
];

const KPIS = [
  { label: "Takeoffs (30d)", value: "540", delta: "+18%", dot: "#f97316" },
  { label: "Eave feet measured", value: "109k", delta: "+24%", dot: "#60a5fa" },
  { label: "Avg turnaround", value: "4 min", delta: "-92%", dot: "#34d399" },
  { label: "Revenue quoted (30d)", value: "$96,330", delta: "+31%", dot: "#f472b6" },
];

function AreaChart() {
  return (
    <svg viewBox="0 0 1000 240" className="mt-8 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="ls-a" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f97316" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#f97316" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="ls-b" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="ls-c" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 60, 120, 180].map((y) => (
        <line key={y} x1="0" x2="1000" y1={y} y2={y} stroke="#2e2b26" strokeWidth="1" />
      ))}
      <path
        d="M0 200 C 90 190, 140 160, 220 158 S 360 175, 450 150 S 610 90, 700 96 S 860 60, 1000 40 V 240 H 0 Z"
        fill="url(#ls-a)"
      />
      <path
        d="M0 200 C 90 190, 140 160, 220 158 S 360 175, 450 150 S 610 90, 700 96 S 860 60, 1000 40"
        fill="none"
        stroke="#f97316"
        strokeWidth="2"
      />
      <path
        d="M0 215 C 110 208, 180 195, 260 190 S 420 196, 520 176 S 680 140, 780 138 S 920 112, 1000 100 V 240 H 0 Z"
        fill="url(#ls-b)"
      />
      <path
        d="M0 215 C 110 208, 180 195, 260 190 S 420 196, 520 176 S 680 140, 780 138 S 920 112, 1000 100"
        fill="none"
        stroke="#60a5fa"
        strokeWidth="2"
      />
      <path
        d="M0 226 C 120 222, 200 216, 300 212 S 480 214, 580 202 S 740 182, 840 178 S 940 164, 1000 158 V 240 H 0 Z"
        fill="url(#ls-c)"
      />
      <path
        d="M0 226 C 120 222, 200 216, 300 212 S 480 214, 580 202 S 740 182, 840 178 S 940 164, 1000 158"
        fill="none"
        stroke="#34d399"
        strokeWidth="2"
      />
    </svg>
  );
}

export function Dashboard() {
  return (
    <section className="bg-[#f2ede3] py-24 md:py-32">
      <Container>
        <SectionHeader
          eyebrow="Live Takeoffs"
          title={
            <>
              See every roof as a
              <br />
              measured takeoff
            </>
          }
          copy="Takeoffs are a new category of estimate — measured, priced, and ready to send. Track every scan, source, and quoted dollar on one dashboard."
        />

        <div className="mt-14 overflow-hidden rounded-[24px] bg-[#1c1a17] p-6 md:p-10">
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map((t) => (
              <span
                key={t.label}
                className={
                  t.active
                    ? "flex items-center gap-2 rounded-full bg-[#33302b] px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white"
                    : "flex items-center gap-2 rounded-full border border-[#33302b] px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-[#8a857c]"
                }
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: t.dot }}
                />
                {t.label}
              </span>
            ))}
          </div>

          <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
            {KPIS.map((k) => (
              <div key={k.label}>
                <p className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#8a857c]">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: k.dot }}
                  />
                  {k.label}
                </p>
                <div className="mt-2 flex items-baseline gap-2">
                  <p className="font-display text-[30px] leading-none text-[#faf8f4] md:text-[36px]">
                    {k.value}
                  </p>
                  <span className="rounded-full bg-[#33302b] px-2 py-0.5 text-[10px] font-semibold text-[#7ee2a8]">
                    {k.delta}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <AreaChart />
          <div className="mt-3 flex justify-between text-[10px] uppercase tracking-wider text-[#57534b]">
            {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"].map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
