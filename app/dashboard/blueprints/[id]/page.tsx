import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, AlertCircle } from "lucide-react";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function BlueprintDetailPage({ params }: Props) {
  const { userId: clerkId } = await auth();
  if (!clerkId) notFound();
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) notFound();

  const { id } = await params;
  const row = await db.planAnalysis.findFirst({
    where: { id, userId: user.id },
  });
  if (!row) notFound();

  // Successful analyses now flow into the unified estimate view so the
  // contractor can edit eaves + downspouts and Save/Send a proposal
  // exactly the way address-based estimates work. This page stays as
  // the failed-state viewer (showing the error) and as the legacy
  // entry point — anything that 404s the modern path will land here.
  if (row.status === "SUCCEEDED") {
    redirect(`/estimate?planId=${row.id}`);
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 space-y-6">
      <Link
        href="/dashboard/blueprints"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition"
      >
        <ChevronLeft size={14} /> Blueprints
      </Link>

      <header>
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight truncate">
          {row.filename}
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          {row.pageCount
            ? `${row.pageCount} page${row.pageCount === 1 ? "" : "s"} · `
            : ""}
          uploaded {new Date(row.createdAt).toLocaleString()}
          {row.modelUsed && ` · ${row.modelUsed}`}
          {row.durationMs && ` · ${(row.durationMs / 1000).toFixed(1)}s`}
          {row.cacheHit && " · cache hit"}
        </p>
      </header>

      {row.status === "FAILED" && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          <div className="flex items-center gap-2 mb-1 font-semibold">
            <AlertCircle size={14} /> Analysis failed
          </div>
          <div className="text-rose-200/90">
            {row.errorMessage ?? "Unknown error"}
          </div>
          <Link
            href="/dashboard/blueprints/new"
            className="inline-block mt-2 text-rose-200 hover:text-white underline underline-offset-2"
          >
            Upload a new plan
          </Link>
        </div>
      )}

      {row.status === "QUEUED" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Analysis is still in progress. Refresh this page in a few seconds.
        </div>
      )}
      {/* Successful analyses redirect to /estimate?planId=... above. */}
    </div>
  );
}
