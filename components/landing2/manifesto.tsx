import { Container } from "./ui";

export function Manifesto() {
  return (
    <section className="bg-white py-24 md:py-36">
      <Container>
        <p className="mx-auto max-w-4xl font-display text-[20px] uppercase leading-[1.3] tracking-[-0.005em] text-[#1c1a17] md:text-[28px]">
          Every day, thousands of homeowners go looking for someone to fix
          their gutters. Each request creates a new kind of job &mdash; priced
          from a roofline, won by whoever measures first,{" "}
          <span className="text-[#cfc9bf]">
            and lost by whoever is still driving out with a tape measure.
            GutterScan makes every roof measurable, priceable, and quotable
            from your desk. Because the future of contracting belongs to the
            crew that sends the proposal before the competition rings the
            doorbell.
          </span>
        </p>
      </Container>
    </section>
  );
}
