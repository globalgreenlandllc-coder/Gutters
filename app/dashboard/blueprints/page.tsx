import { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Plus, FileText, Clock, AlertCircle, CheckCircle2 } from "lucide-react";

import { db } from "@/lib/db";

export const metadata: Metadata = {
  title: "Blueprints · Gutters",
  description: "AI-generated gutter layouts from construction plans.",
};

export default async function BlueprintsListPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return (
      <div className="p-8 text-slate-400">Sign in to view blueprints.</div>
    );
  }
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    return <div className="p-8 text-slate-400">User not found.</div>;
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
    <div className="w-full max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">
            Blueprints
          </h1>
          <p className="text-slate-400 mt-1">
            AI-generated gutter layouts from construction plans.
          </p>
        </div>
        <Link
          href="/dashboard/blueprints/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 transition"
        >
          <Plus size={14} /> New blueprint
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-12 text-center">
          <div className="mx-auto rounded-full bg-emerald-500/10 p-3 w-fit ring-1 ring-emerald-500/30 text-emerald-300 mb-3">
            <FileText size={24} />
          </div>
          <div className="text-white font-semibold mb-1">No blueprints yet</div>
          <p className="text-slate-400 text-sm max-w-md mx-auto">
            Upload a roof plan to generate a gutter layout. Claude reads the
            plan, classifies edges, and returns LF + downspout placement.
          </p>
          <Link
            href="/dashboard/blueprints/new"
            className="inline-flex items-center gap-1.5 mt-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 transition"
          >
            <Plus size={14} /> Create one
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const StatusIcon =
              r.status === "SUCCEEDED"
                ? CheckCircle2
                : r.status === "FAILED"
                  ? AlertCircle
                  : Clock;
            const statusColor =
              r.status === "SUCCEEDED"
                ? "text-emerald-400"
                : r.status === "FAILED"
                  ? "text-rose-400"
                  : "text-amber-400";
            return (
              <li key={r.id}>
                <Link
                  href={`/dashboard/blueprints/${r.id}`}
                  className="block rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800/60 transition px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <FileText size={18} className="text-slate-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm font-medium truncate">
                        {r.filename}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {r.pageCount ? `${r.pageCount} page${r.pageCount === 1 ? "" : "s"} · ` : ""}
                        {new Date(r.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-xs font-medium ${statusColor}`}>
                      <StatusIcon size={13} />
                      {r.status.toLowerCase()}
                    </span>
                    {r.confidence && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 ring-1 ring-slate-700">
                        {r.confidence}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
