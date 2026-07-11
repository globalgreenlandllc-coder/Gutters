import { getAnalyticsOverview, getLiveNow } from "@/app/actions/analytics";
import { AnalyticsDashboard } from "@/components/admin/analytics/analytics-dashboard";

// Live traffic + acquisition analytics. Auth is enforced by the admin
// layout (requireSuperAdmin); the data actions re-check the role on
// every call since the live strip polls them from the client.

export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage() {
  const [overview, live] = await Promise.all([
    getAnalyticsOverview(7),
    getLiveNow(),
  ]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
            Analytics
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Who&apos;s on GutterScan right now, where they came from, and how
            visitors turn into paying contractors.
          </p>
        </div>
      </header>
      <AnalyticsDashboard initialOverview={overview} initialLive={live} />
    </div>
  );
}
