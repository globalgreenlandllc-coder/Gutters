import "@/components/landing2/landing.css";

import { Banner } from "@/components/landing2/banner";
import { Nav } from "@/components/landing2/nav";
import { Hero } from "@/components/landing2/hero";
import { FlowDivider } from "@/components/landing2/flow-divider";
import { Stats } from "@/components/landing2/stats";
import { Logos } from "@/components/landing2/logos";
import { Manifesto } from "@/components/landing2/manifesto";
import { Engine } from "@/components/landing2/engine";
import { Detection } from "@/components/landing2/detection";
import { Gap } from "@/components/landing2/gap";
import { Dashboard } from "@/components/landing2/dashboard";
import { Tiers } from "@/components/landing2/tiers";
import { Insights } from "@/components/landing2/insights";
import { CTA } from "@/components/landing2/cta";
import { Footer } from "@/components/landing2/footer";

export default function HomePage() {
  return (
    <main className="relative bg-paper text-ink">
      <Banner />
      <Nav />
      <Hero />
      <FlowDivider />
      <Stats />
      <Logos />
      <Manifesto />
      <Engine />
      <Detection />
      <Gap />
      <Dashboard />
      <Tiers />
      <Insights />
      <CTA />
      <Footer />
    </main>
  );
}
