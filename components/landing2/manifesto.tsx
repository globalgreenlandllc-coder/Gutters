import { Container } from "./ui";
import { Reveal } from "./reveal";

export function Manifesto() {
  return (
    <section className="bg-white py-24 md:py-36">
      <Container>
        <Reveal>
          <p className="mx-auto max-w-4xl text-[22px] font-semibold leading-[1.35] tracking-tight text-zinc-900 md:text-[30px]">
            Every day, thousands of homeowners go looking for someone to fix
            their gutters. Each request creates a new kind of job &mdash; priced
            from a roofline, won by whoever measures first,{" "}
            <span className="text-zinc-400">
              and lost by whoever is still driving out with a tape measure.
              GutterScan makes every roof measurable, priceable, and quotable
              from your desk. Because the future of contracting belongs to the
              crew that sends the proposal before the competition rings the
              doorbell.
            </span>
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
