import { Container } from "./ui";

const STATS = [
  { label: "Quoted through GutterScan", value: "$10M+" },
  { label: "Eave feet measured", value: "2M+" },
  { label: "Active contractors", value: "250+" },
];

export function Stats() {
  return (
    <section className="pb-16 pt-6 md:pb-24">
      <Container>
        <div className="grid gap-3 md:grid-cols-4">
          <div className="flex min-h-[168px] flex-col justify-between rounded-2xl bg-[#1c1a17] p-6">
            <span className="inline-block h-[7px] w-[7px] rounded-[2px] bg-[#f97316]" />
            <p className="text-[15px] leading-snug text-[#faf8f4]">
              Trusted by contractors
              <br />
              estimating with AI
              <br />
              at scale
            </p>
          </div>
          {STATS.map((s) => (
            <div
              key={s.label}
              className="flex min-h-[168px] flex-col justify-between rounded-2xl border border-[#e9e5dd] bg-white p-6"
            >
              <p className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[#8a857c]">
                {s.label}
              </p>
              <p className="font-display text-[42px] leading-none text-[#1c1a17]">
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
