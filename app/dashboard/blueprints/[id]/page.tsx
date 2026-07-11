import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, AlertCircle } from "lucide-react";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import {
  VectorInspector,
  type ExtractedVectors,
  type PageVectors,
} from "@/components/blueprints/vector-inspector";

interface Props {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ inspect?: string }>;
}

export default async function BlueprintDetailPage({
  params,
  searchParams,
}: Props) {
  const { userId: clerkId } = await auth();
  if (!clerkId) notFound();
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) notFound();

  const { id } = await params;
  const inspect = (await searchParams)?.inspect === "1";
  const row = await db.planAnalysis.findFirst({
    where: { id, userId: user.id },
  });
  if (!row) notFound();

  // _vectorGeometry is PlanVectors ({ footprint, roof }) on current rows;
  // legacy rows stored a single flat page — normalize those as the footprint.
  const rawVectors = (
    row.analysisJson as {
      _vectorGeometry?: ExtractedVectors | PageVectors;
    } | null
  )?._vectorGeometry;
  const vectors: ExtractedVectors | undefined = rawVectors
    ? "footprint" in rawVectors || "roof" in rawVectors
      ? (rawVectors as ExtractedVectors)
      : { footprint: rawVectors as PageVectors, roof: null }
    : undefined;

  // Successful analyses now flow into the unified estimate view so the
  // contractor can edit eaves + downspouts and Save/Send a proposal
  // exactly the way address-based estimates work. This page stays as
  // the failed-state viewer (showing the error) and as the legacy
  // entry point — anything that 404s the modern path will land here.
  // ?inspect=1 overrides the redirect to debug the extracted vector layer.
  if (row.status === "SUCCEEDED" && !inspect) {
    redirect(`/estimate?planId=${row.id}`);
  }

  const metaLine = [
    row.pageCount
      ? `${row.pageCount} page${row.pageCount === 1 ? "" : "s"}`
      : null,
    `uploaded ${new Date(row.createdAt).toLocaleString()}`,
    row.modelUsed,
    row.durationMs ? `${(row.durationMs / 1000).toFixed(1)}s` : null,
    row.cacheHit ? "cache hit" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <DashboardShell
      title={row.filename}
      subtitle={metaLine}
      contentClassName="max-w-6xl"
    >
      <div className="space-y-6">
        <Link
          href="/dashboard/blueprints"
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-zinc-900"
        >
          <ChevronLeft size={14} /> Blueprints
        </Link>

        {row.status === "FAILED" && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <AlertCircle size={14} /> Analysis failed
            </div>
            <div className="text-rose-700/90">
              {row.errorMessage ?? "Unknown error"}
            </div>
            <Link
              href="/dashboard/blueprints/new"
              className="mt-2 inline-block text-rose-700 underline underline-offset-2 hover:text-rose-900"
            >
              Upload a new plan
            </Link>
          </div>
        )}

        {row.status === "QUEUED" && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
            Analysis is still in progress. Refresh this page in a few seconds.
          </div>
        )}
        {inspect &&
          (vectors ? (
            <div className="space-y-3">
              <Link
                href={`/estimate?planId=${row.id}`}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-700 transition hover:text-accent-800"
              >
                Open the takeoff →
              </Link>
              <VectorInspector vg={vectors} />
            </div>
          ) : (
            <div className="surface p-4 text-sm text-zinc-600">
              No vector data was extracted for this plan — it may be a raster /
              scanned PDF, a non-vector export, or the page had no usable text or
              line geometry. Stage 2 ran vision-only.
            </div>
          ))}
        {/* Successful analyses redirect to /estimate?planId=... above (unless
            ?inspect=1, which shows the extracted-vector debug view here). */}
      </div>
    </DashboardShell>
  );
}
