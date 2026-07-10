"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Zap } from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-nav";
import { BrandProfileSection } from "@/components/dashboard/brand-profile-section";
import { PaymentsSection } from "@/components/dashboard/payments-section";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/auth-mock";
import {
  createCreditsCheckout,
  createSubscriptionCheckout,
  getMyBilling,
  openBillingPortal,
  type MyBilling,
} from "@/app/actions/billing";
import { formatCurrency } from "@/lib/utils";

export default function SettingsPage() {
  return (
    <AuthGate>
      <DashboardShell title="Settings" contentClassName="max-w-4xl">
        <div className="space-y-6">
          <p className="text-sm text-zinc-500">
            Configure your brand, payments, and pricing baselines.
          </p>

          <BrandProfileSection />

          <PaymentsSection />

          <BillingSection />

          <Section
            eyebrow="Pricing"
            title="Baseline pricing"
            sub="Per-LF prices, labor minimums, and tax rates flow into every estimate."
            badge={{ label: "Configured", tone: "emerald" }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={'6" K-style aluminum'} value="$12.00 / LF" />
              <Field label="3×4 downspout" value="$9.00 / LF" />
              <Field label="Hidden hangers" value="$3.25 / ea" />
              <Field label="Default markup" value="15%" />
              <Field label="Sales tax (TX)" value="8.25%" />
              <Field label="Labor minimum" value="$250" />
            </div>
          </Section>
        </div>
      </DashboardShell>
    </AuthGate>
  );
}

function BillingSection() {
  const { session } = useSession();
  const credits = session?.credits;
  const used = credits?.used ?? 0;
  const total = (credits?.included ?? 12) + (credits?.bonus ?? 0);
  const remaining = Math.max(total - used, 0);
  const pct = Math.round((used / total) * 100);
  const isAdmin = session?.user.role === "SUPER_ADMIN";

  const [billing, setBilling] = useState<MyBilling | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    getMyBilling().then(setBilling).catch(() => undefined);
    // Post-checkout return banner (?billing=success|credits|cancelled).
    const params = new URLSearchParams(window.location.search);
    const b = params.get("billing");
    if (b === "success")
      setBanner("🎉 Welcome to Pro — your plan is activating (a few seconds).");
    if (b === "credits")
      setBanner("✓ Credits purchased — they'll appear in your wallet shortly.");
    if (b === "cancelled") setBanner("Checkout cancelled — nothing was charged.");
    if (b) {
      params.delete("billing");
      const q = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (q ? `?${q}` : ""),
      );
    }
  }, []);

  async function go(
    key: string,
    fn: () => Promise<{ ok: true; url: string } | { ok: false; reason: string }>,
  ) {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      window.location.href = result.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(null);
    }
  }

  const plan = billing?.plan ?? null;
  const planActive = plan?.status === "ACTIVE";
  const planPastDue = plan?.status === "PAST_DUE";
  const badge = planActive
    ? { label: "Pro · Active", tone: "emerald" as const }
    : planPastDue
      ? { label: "Payment failed", tone: "amber" as const }
      : { label: "Free trial", tone: "amber" as const };

  return (
    <Section
      eyebrow="Billing"
      title="Plan & credits"
      sub="$50/month · 12 estimates included · top up extra credits anytime."
      badge={badge}
    >
      {banner && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {banner}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[26px] font-semibold tracking-tight tabular-nums text-zinc-900">
              {isAdmin ? "Unlimited" : remaining}
            </span>
            <span className="text-xs text-zinc-500">
              {isAdmin ? "admin account" : `of ${total} credits remaining`}
            </span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-accent-600"
              style={{ width: `${isAdmin ? 100 : Math.max(0, 100 - pct)}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Stat label="Used this month" value={`${used}`} />
            <Stat
              label="Renews"
              value={
                credits?.resetsAt
                  ? new Date(credits.resetsAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : "—"
              }
            />
            <Stat label="Same-address re-runs" value="10× / 24h · free" />
            <Stat label="Bonus credits" value={`${credits?.bonus ?? 0}`} />
          </div>

          {/* Credit packs — bonus credits never expire */}
          {!isAdmin && (
            <div className="mt-4 border-t border-zinc-200 pt-4">
              <div className="font-label text-[10px] text-zinc-400">
                Need more estimates? Buy credits
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(billing?.packs ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={busy !== null || !billing?.configured}
                    onClick={() => go(p.id, () => createCreditsCheckout(p.id))}
                    className="inline-flex flex-col items-start rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left transition hover:border-accent-400 hover:bg-accent-50/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
                      {busy === p.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Zap className="h-3.5 w-3.5 text-accent-600" />
                      )}
                      {p.credits} credits · {formatCurrency(p.amountCents / 100)}
                    </span>
                    <span className="mt-0.5 text-[11px] text-zinc-500">
                      {p.blurb}
                    </span>
                  </button>
                ))}
              </div>
              {billing && !billing.configured && (
                <p className="mt-2 text-[11px] text-zinc-400">
                  Purchasing is unavailable until Stripe is configured
                  {isAdmin ? " in /admin/api-keys" : " — contact support"}.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4">
          <div>
            <div className="text-sm font-semibold text-zinc-900">Pro plan</div>
            <div className="mt-1 text-xs text-zinc-500">
              {formatCurrency((billing?.proPriceCents ?? 5000) / 100)}/month ·
              billed monthly
            </div>
            <ul className="mt-3 space-y-1.5 text-xs text-zinc-600">
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-accent-600" />
                12 estimates / month
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-accent-600" />
                Re-run any address 10× / 24h
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-accent-600" />
                Client portals, receipts &amp; change orders
              </li>
            </ul>
            {planActive && plan?.renewsAt && (
              <p className="mt-3 text-[11px] text-zinc-500">
                {plan.cancelAtPeriodEnd ? "Ends" : "Renews"}{" "}
                {new Date(plan.renewsAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
                {plan.cancelAtPeriodEnd && " — cancellation scheduled"}
              </p>
            )}
            {planPastDue && (
              <p className="mt-3 text-[11px] font-medium text-rose-600">
                Last payment failed — update your card to keep Pro.
              </p>
            )}
          </div>
          {planActive || planPastDue ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => go("portal", openBillingPortal)}
            >
              {busy === "portal" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              Manage plan
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy !== null || (billing !== null && !billing.configured)}
              onClick={() => go("subscribe", createSubscriptionCheckout)}
            >
              {busy === "subscribe" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              Upgrade to Pro
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}

function Section({
  eyebrow,
  title,
  sub,
  badge,
  children,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  badge?: { label: string; tone: "accent" | "amber" | "emerald" };
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-label text-[11px] text-zinc-400">{eyebrow}</div>
          <h2 className="mt-1 text-base font-semibold tracking-tight text-zinc-900">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-zinc-500">{sub}</p>
        </div>
        {badge && (
          <Badge tone={badge.tone}>
            {badge.tone !== "amber" && <CheckCircle2 className="h-3 w-3" />}
            {badge.label}
          </Badge>
        )}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 px-3 py-2.5">
      <div className="font-label text-[10px] text-zinc-400">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-zinc-900">{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2">
      <div className="font-label text-[10px] text-zinc-400">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-zinc-900">{value}</div>
    </div>
  );
}
