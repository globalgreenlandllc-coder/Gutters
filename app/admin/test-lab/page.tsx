import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { listLabRuns } from "@/app/actions/test-lab";
import { TestLabClient } from "@/components/admin/test-lab/test-lab-client";

export const dynamic = "force-dynamic";
// Lab runs invoke the full estimate engine (geocode + Solar layers +
// trace) from this route's server actions — same budget as /estimate.
export const maxDuration = 90;
export const metadata = { title: "Accuracy lab — Admin" };

export default async function TestLabPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const standalone = view === "standalone";
  const { runs, aggregate } = await listLabRuns();

  if (standalone) {
    // Pop-out for a big screen: covers the admin shell entirely.
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-paper">
        <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Logo showSubtitle={false} />
              <span className="hidden text-sm text-zinc-400 sm:inline">/ Accuracy lab</span>
            </div>
            <Link
              href="/admin/test-lab"
              className="transition-smooth ring-focus press-scale inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-card hover:text-zinc-900"
            >
              <ArrowLeft className="h-4 w-4" /> Back to admin
            </Link>
          </header>
          <TestLabClient initialRuns={runs} initialAggregate={aggregate} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
            Accuracy lab
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Run test addresses, correct the trace, and every fix becomes ground truth the engine
            is re-tested against. Users always get the same engine this lab trains.
          </p>
        </div>
        <Link
          href="/admin/test-lab?view=standalone"
          target="_blank"
          rel="noopener"
          className="transition-smooth ring-focus press-scale inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-card hover:text-zinc-900"
        >
          <ExternalLink className="h-4 w-4" /> Pop out
        </Link>
      </header>
      <TestLabClient initialRuns={runs} initialAggregate={aggregate} />
    </div>
  );
}
