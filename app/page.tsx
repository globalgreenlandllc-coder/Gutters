import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { DashboardCascade } from "@/components/landing/dashboard-cascade";
import { OldVsAi } from "@/components/landing/old-vs-ai";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Features } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { CTA } from "@/components/landing/cta";
import { Footer } from "@/components/landing/footer";

export default function HomePage() {
  return (
    <main className="relative">
      <Nav />
      <Hero />
      <DashboardCascade />
      <OldVsAi />
      <HowItWorks />
      <Features />
      <Pricing />
      <CTA />
      <Footer />
    </main>
  );
}
