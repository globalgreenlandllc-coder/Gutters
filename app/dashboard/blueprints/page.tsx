import { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Plus, FileText, Clock, AlertCircle, CheckCircle2 } from "lucide-react";

import { db } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "Blueprints · Gutters",
  description: "AI-generated gutter layouts from construction plans.",
};

export default async function BlueprintsListPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return (
      <DashboardShell title="Blueprints">
        <p className="text-sm text-zinc-500">Sign in to view blueprints.</p>
      </DashboardShell>
    );
  }
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    return (
      <DashboardShell title="Blueprints">
        <p className="text-sm text-zinc-500">User not found.</p>
      </DashboardShell>
    );
  }

  const rows = await db.planAnalysis.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      filename: true,
      status: true,
      confidence: true,
      pageCount: true,
      createdAt: true,
    },
  });

  return (
    <DashboardShell
      title="Blueprints"
      actions={
        <Link
          href="/dashboard/blueprints/new"
          className="ring-focus inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-accent-700"
        >
          <Plus size={14} /> New blueprint
        </Link>
      }
    >
      <div className="space-y-6">
        <p className="text-sm text-zinc-500">
          AI-generated gutter layouts from construction plans.
        </p>

        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center">
            <div className="mx-auto mb-3 w-fit rounded-full bg-accent-50 p-3 text-accent-600 ring-1 ring-accent-200">
              <FileText size={24} />
            </div>
            <div className="mb-1 font-semibold tracking-tight text-zinc-900">
              No blueprints yet
            </div>
            <p className="mx-auto max-w-md text-sm text-zinc-500">
              Upload a roof plan to generate a gutter layout. Claude reads the
              plan, classifies edges, and returns LF + downspout placement.
            </p>
            <Link
              href="/dashboard/blueprints/new"
              className="ring-focus mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-700"
            >
              <Plus size={14} /> Create one
            </Link>
          </div>
        ) : (
          <ul className="surface divide-y divide-zinc-100 shadow-card">
            {rows.map((r) => {
              const StatusIcon =
                r.status === "SUCCEEDED"
                  ? CheckCircle2
                  : r.status === "FAILED"
                    ? AlertCircle
                    : Clock;
              const statusTone =
                r.status === "SUCCEEDED"
                  ? "emerald"
                  : r.status === "FAILED"
                    ? "rose"
                    : "amber";
              return (
                <li key={r.id}>
                  <Link
                    href={
                      r.status === "SUCCEEDED"
                        ? `/estimate?planId=${r.id}`
                        : `/dashboard/blueprints/${r.id}`
                    }
                    className="block px-4 py-3.5 transition hover:bg-zinc-50/60"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
                        <FileText size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-900">
                          {r.filename}
                        </div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {r.pageCount ? `${r.pageCount} page${r.pageCount === 1 ? "" : "s"} · ` : ""}
                          {new Date(r.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <Badge tone={statusTone}>
                        <StatusIcon size={13} />
                        {r.status.toLowerCase()}
                      </Badge>
                      {r.confidence && (
                        <Badge tone="neutral">{r.confidence}</Badge>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DashboardShell>
  );
}
