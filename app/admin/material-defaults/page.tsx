import { ComingSoon } from "@/components/admin/coming-soon";

export default function AdminMaterialDefaultsPage() {
  return (
    <ComingSoon
      title="Material defaults"
      description="Baseline national-average material prices that pre-populate every new contractor's account."
      bullets={[
        '5" / 6" / 7" K-style + half-round gutters in aluminum, steel, copper',
        '2"×3", 3"×4", 3" round, 4" round downspouts',
        "Hangers, miters, end caps, gutter guards",
        "New contractors inherit these on signup; they can override per account",
      ]}
    />
  );
}
