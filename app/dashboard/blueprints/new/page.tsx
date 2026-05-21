import { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import BlueprintUploader from "@/components/blueprints/BlueprintUploader";

export const metadata: Metadata = {
  title: "New Blueprint · Gutters",
  description:
    "Upload construction plans and have Claude generate a gutter layout blueprint.",
};

export default function NewBlueprintPage() {
  return (
    <div className="w-full max-w-3xl mx-auto px-4 py-8 space-y-6">
      <Link
        href="/dashboard/blueprints"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition"
      >
        <ChevronLeft size={14} /> Blueprints
      </Link>
      <header>
        <h1 className="text-3xl font-bold text-white tracking-tight">
          New blueprint
        </h1>
        <p className="text-slate-400 mt-1 max-w-xl">
          Upload a roof plan (PDF or image). Claude reads it, identifies every
          eave vs rake, and produces a gutter layout you can include in the
          customer proposal.
        </p>
      </header>
      <BlueprintUploader />
    </div>
  );
}
