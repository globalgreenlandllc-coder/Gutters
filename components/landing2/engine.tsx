import { Container, Eyebrow, PillLink } from "./ui";
import { PlanTrace } from "./house-scene";

const ROWS = [
  {
    title: "Roofs traced from the sky",
    body: "The fastest-growing way to win gutter work. Invisible to a tape measure. Instant for our engine.",
    open: true,
  },
  { title: "Blueprints read automatically", open: false },
  { title: "Proposals sent the same hour", open: false },
];

function TracePanel() {
  return (
    <div className="w-[240px] rounded-xl border border-[#e9e5dd] bg-white p-4 shadow-[0_20px_45px_-20px_rgba(28,26,23,0.25)]">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-[#1c1a17]">Roof Trace</p>
        <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#15803d]">
          Complete
        </span>
      </div>
      <div className="mt-3 space-y-2 border-t border-[#f0ede6] pt-3">
        {[
          ["Address", "1425 Maple Ave"],
          ["Eaves", "186 LF"],
          ["Downspouts", "8"],
          ["Confidence", "94%"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-[11px]">
            <span className="text-[#8a857c]">{k}</span>
            <span className="font-medium text-[#1c1a17]">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg bg-[#ecfdf3] px-3 py-2 text-[11px] font-semibold text-[#15803d]">
        $2,325 estimate ready
      </div>
    </div>
  );
}


export function Engine() {
  return (
    <section id="takeoffs" className="bg-[#faf8f4] py-24 md:py-32">
      <Container>
        <div className="grid gap-14 md:grid-cols-2 md:gap-20">
          <div>
            <Eyebrow>AI Takeoffs</Eyebrow>
            <h2 className="mt-6 font-display text-[30px] uppercase leading-[0.98] text-[#1c1a17] md:text-[40px]">
              AI measures the roofs{" "}
              <span className="text-[#b3ada2]">you never visit</span>
            </h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-[#6e6a62]">
              Every address hides a full takeoff &mdash; eave runs, corners,
              stories, downspout drops &mdash; that your current process only
              reveals with a truck roll. GutterScan makes it visible.
            </p>
            <div className="mt-7">
              <PillLink href="/sign-in">Get Started</PillLink>
            </div>

            <div className="mt-12 divide-y divide-[#e9e5dd] border-t border-[#e9e5dd]">
              {ROWS.map((r) => (
                <div key={r.title} className="py-5">
                  <div className="flex items-center justify-between">
                    <p className="font-display text-[14px] uppercase tracking-tight text-[#1c1a17]">
                      {r.title}
                    </p>
                    <span className="text-[18px] leading-none text-[#b3ada2]">
                      {r.open ? "–" : "+"}
                    </span>
                  </div>
                  {r.body ? (
                    <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-[#8a857c]">
                      {r.body}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="relative flex items-center rounded-[24px] bg-[#f1ede4] p-6 md:p-10">
            <div className="w-full">
              <PlanTrace />
            </div>
            <div className="absolute bottom-8 right-6 md:right-10">
              <TracePanel />
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
