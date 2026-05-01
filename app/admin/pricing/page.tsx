import { ComingSoon } from "@/components/admin/coming-soon";

export default function AdminPricingPage() {
  return (
    <ComingSoon
      title="Pricing CMS"
      description="Edit subscription tiers and per-credit add-ons. Saving creates a new immutable Stripe Price and updates the public landing page."
      bullets={[
        "Subscription tiers — name, monthly price, included credits, feature list",
        "Add-on credit price — flat $/address",
        "Stripe sync: creates new Price object on save (existing customers grandfather)",
        "Live preview of the landing page Pricing section before publish",
      ]}
    />
  );
}
