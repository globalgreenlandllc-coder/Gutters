import LeadsMap from "@/components/leads/LeadsMap";
import { getActiveApiKey } from "@/lib/api-keys";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Leads Map - Smart Permit Tracker",
  description: "Find and track construction permits as actionable leads.",
};

export default async function LeadsPage() {
  const googleMapsKey = await getActiveApiKey("GOOGLE_MAPS");

  return (
    <div className="w-full h-screen flex flex-col">
      <main className="flex-1 overflow-hidden relative">
        <LeadsMap apiKey={googleMapsKey || "dummy_key"} />
      </main>
    </div>
  );
}
