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
    <DashboardShell title="Blueprints" contentClassName="max-w-3xl">
      <div className="space-y-6">
        <Link
          href="/dashboard/blueprints"
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-zinc-900"
        >
          <ChevronLeft size={14} /> Blueprints
        </Link>
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            New blueprint
          </h1>
          <p className="mt-1 max-w-xl text-sm text-zinc-500">
            Upload a roof plan (PDF or image). Claude reads it, identifies every
            eave vs rake, and produces a gutter layout you can include in the
            customer proposal.
          </p>
        </header>
        <BlueprintUploader />
      </div>
    </DashboardShell>
  );
}
