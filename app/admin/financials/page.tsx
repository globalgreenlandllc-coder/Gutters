import { ComingSoon } from "@/components/admin/coming-soon";

export default function AdminFinancialsPage() {
  return (
    <ComingSoon
      title="Financials"
      description="SaaS subscription ledger, proposal payment ledger, refunds. Backed by the transactions table — all events stream in via Stripe webhooks."
      bullets={[
        "SaaS subscriptions table — every Stripe Billing event by contractor",
        "Proposal payment ledger — homeowner → contractor, with platform fee split",
        "Refund flow — re-issue any subscription or proposal payment",
        "CSV export of any filtered ledger view",
      ]}
    />
  );
}
