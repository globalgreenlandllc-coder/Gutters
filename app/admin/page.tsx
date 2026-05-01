import {
  ArrowUpRight,
  CreditCard,
  Receipt,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users as UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { getAdminKpis, recentAdminActivity } from "@/app/actions/admin";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";

export default async function AdminOverviewPage() {
  const [kpis, activity] = await Promise.all([
    getAdminKpis(),
    recentAdminActivity(),
  ]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
            Platform overview
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Live counts and money flowing through Gutters AI right now.
          </p>
        </div>
        <Badge tone="accent">
          <ShieldCheck className="h-3 w-3" />
          All checks healthy
        </Badge>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          icon={UsersIcon}
          label="Active contractors"
          value={String(kpis.contractorsActive)}
          sub={`${kpis.contractorsSuspended} suspended`}
          accent="emerald"
        />
        <Tile
          icon={Sparkles}
          label="Estimates this month"
          value={String(kpis.estimatesThisMonth)}
          sub={`${kpis.estimatesAllTime} all time`}
          accent="violet"
        />
        <Tile
          icon={TrendingUp}
          label="MRR"
          value={formatCurrency(kpis.mrrCents / 100)}
          sub="Active SaaS subs × $50"
          accent="sky"
        />
        <Tile
          icon={Receipt}
          label="Platform fees collected"
          value={formatCurrency(kpis.platformFeesCents / 100)}
          sub={`${formatCurrency(kpis.revenueProcessedCents / 100)} processed`}
          accent="amber"
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-card">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
                Quick actions
              </h2>
              <span className="text-xs text-zinc-500">
                Most-used admin surfaces
              </span>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ActionLink
                href="/admin/users"
                title="Manage contractors"
                body="Adjust credits, suspend, impersonate."
              />
              <ActionLink
                href="/admin/financials"
                title="Open the ledger"
                body="Subscriptions + proposal payments + refunds."
              />
              <ActionLink
                href="/admin/api-keys"
                title="API key vault"
                body="Rotate Google, OpenAI, Stripe, Resend keys."
              />
              <ActionLink
                href="/admin/pricing"
                title="Pricing CMS"
                body="Edit plans + sync to Stripe."
              />
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-card">
            <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
              Conversion this month
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Proposals accepted vs. estimates run.
            </p>
            <div className="mt-4 flex items-end justify-between">
              <div>
                <div className="font-display text-4xl font-semibold tabular-nums text-zinc-900">
                  {kpis.estimatesThisMonth === 0
                    ? "0%"
                    : Math.round(
                        (kpis.proposalsAccepted /
                          Math.max(kpis.estimatesThisMonth, 1)) *
                          100,
                      ) + "%"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {kpis.proposalsAccepted} accepted ·{" "}
                  {kpis.estimatesThisMonth} estimates
                </div>
              </div>
              <Badge tone="neutral">
                <CreditCard className="h-3 w-3" />
                Updated live
              </Badge>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold tracking-tight text-zinc-900">
              Recent activity
            </h2>
            <span className="text-xs text-zinc-500">Across all contractors</span>
          </div>
          {activity.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
              No proposal activity yet. Once contractors send proposals,
              homeowner views and acceptances will land here.
            </div>
          ) : (
            <ul className="mt-4 space-y-1.5">
              {activity.map((a) => (
                <li
                  key={a.id}
                  className="rounded-lg border border-zinc-100 bg-zinc-50/40 px-3 py-2 text-sm"
                >
                  <div className="text-zinc-800">{a.message}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {new Date(a.at).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  accent: "emerald" | "violet" | "sky" | "amber";
}) {
  const bg = {
    emerald: "bg-accent-50 text-accent-700",
    violet: "bg-violet-50 text-violet-700",
    sky: "bg-sky-50 text-sky-700",
    amber: "bg-amber-50 text-amber-700",
  }[accent];
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${bg}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </span>
      </div>
      <div className="mt-3 font-display text-3xl font-semibold tracking-tight tabular-nums text-zinc-900">
        {value}
      </div>
      <div className="mt-1 text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

function ActionLink({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 rounded-xl border border-zinc-200 bg-zinc-50/40 p-4 transition hover:border-accent-300 hover:bg-white"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-900">{title}</span>
        <ArrowUpRight className="h-3.5 w-3.5 text-zinc-400 transition group-hover:text-accent-700" />
      </div>
      <span className="text-xs text-zinc-500">{body}</span>
    </Link>
  );
}
