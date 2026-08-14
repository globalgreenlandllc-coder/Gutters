import { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import BlueprintUploader from "@/components/blueprints/BlueprintUploader";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";

export const metadata: Metadata = {
  title: "New Blueprint · Gutters",
  description:
    "Upload construction plans and have Claude generate a gutter layout blueprint.",
};

export default function NewBlueprintPage() {
  return (
    <DashboardShell
      title="New blueprint"
      subtitle="Upload a roof plan (PDF or image). Claude reads it, identifies every eave vs rake, and produces a gutter layout you can include in the customer proposal."
      contentClassName="max-w-3xl"
    >
      <div className="anim-enter space-y-6">
        <Link
          href="/dashboard/blueprints"
          className="ring-focus group inline-flex items-center gap-1.5 rounded-md text-sm text-zinc-500 transition-smooth hover:text-zinc-900"
        >
          <ChevronLeft
            size={14}
            className="transition-transform group-hover:-translate-x-0.5 motion-reduce:transition-none"
          />{" "}
          Blueprints
        </Link>
        <BlueprintUploader />
      </div>
    </DashboardShell>
  );
}
