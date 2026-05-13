import LeadsMap from "../../components/leads/LeadsMap";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Leads Map - Smart Permit Tracker",
  description: "Find and track construction permits as actionable leads.",
};

export default function LeadsPage() {
  return (
    <div className="w-full h-screen flex flex-col">
      {/* Top Navbar / Header could go here. Assuming it is handled by a root layout. */}
      {/* If root layout has a header, this calc(100vh - headerHeight) is used in LeadsMap */}
      
      <main className="flex-1 overflow-hidden relative">
        <LeadsMap />
      </main>
    </div>
  );
}
