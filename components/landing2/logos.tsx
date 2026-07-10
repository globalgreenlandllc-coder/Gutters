import { Container } from "./ui";

/* Fictional trade-press / partner wordmarks, rendered as grayscale type. */
const MARKS = [
  <span key="1" className="font-display text-[16px] uppercase tracking-tight">
    The Rain Post
  </span>,
  <span key="2" className="text-[15px] font-black uppercase tracking-[0.12em]">
    Contractor Insider
  </span>,
  <span key="3" className="text-[17px] font-bold lowercase tracking-tight">
    roofline<span className="font-normal">/finance</span>
  </span>,
  <span key="4" className="text-[17px] font-semibold tracking-tight">
    Exteriors.com
  </span>,
  <span key="5" className="font-mono text-[15px] font-bold tracking-tight">
    Pacific_Builder
  </span>,
];

export function Logos() {
  return (
    <section className="border-y border-[#eae6de] bg-[#faf8f4] py-8">
      <Container>
        <div className="flex flex-wrap items-center justify-center gap-x-14 gap-y-6 text-[#8f8a81] md:justify-between">
          {MARKS.map((m) => (
            <div key={m.key} className="opacity-80 grayscale">
              {m}
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
