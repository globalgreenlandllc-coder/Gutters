"use client";

import { motion } from "framer-motion";
import { CheckCircle2, FileText, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { packageTotal, type Proposal } from "@/lib/proposal-mock";

export function BuilderSidebar({
  proposal,
  onChange,
  onSend,
}: {
  proposal: Proposal;
  onChange: (p: Proposal) => void;
  onSend: () => void;
}) {
  const totals = proposal.packages.map((p) => ({
    pkg: p,
    total: packageTotal(p, proposal.measurements).total,
  }));
  const recommended =
    totals.find((t) => t.pkg.recommended) ?? totals[1] ?? totals[0];
  const enabledTermsCount = proposal.terms.filter((t) => t.enabled).length;

  return (
    <aside className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
        <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Most popular
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-display text-3xl font-semibold tracking-tight text-zinc-900 tabular-nums">
            {recommended ? formatCurrency(recommended.total) : "—"}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {recommended?.pkg.name}
        </div>

        <div className="mt-5 space-y-2">
          {totals.map(({ pkg, total }) => (
            <div
              key={pkg.id}
              className="flex items-center justify-between text-sm"
            >
              <span className="text-zinc-700">{pkg.name}</span>
              <motion.span
                key={Math.round(total)}
                initial={{ opacity: 0.4 }}
                animate={{ opacity: 1 }}
                className="tabular-nums text-zinc-900"
              >
                {formatCurrency(total)}
              </motion.span>
            </div>
          ))}
        </div>

        <div className="my-4 h-px w-full bg-zinc-100" />

        <div className="space-y-2 text-xs text-zinc-600">
          <Field
            label="Deposit %"
            value={proposal.depositPct}
            suffix="%"
            onChange={(v) => onChange({ ...proposal, depositPct: v })}
          />
          <Field
            label="Valid days"
            value={proposal.validDays}
            onChange={(v) => onChange({ ...proposal, validDays: v })}
          />
        </div>

        <Button onClick={onSend} className="mt-5 w-full">
          <Send className="h-4 w-4" />
          Send to client
        </Button>
        <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <FileText className="h-3 w-3" />
            {proposal.photos.length} photos · {enabledTermsCount} terms
          </span>
          <Badge tone="neutral">Auto-saved</Badge>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
        <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Recipient
        </div>
        <input
          value={proposal.client.name}
          onChange={(e) =>
            onChange({
              ...proposal,
              client: { ...proposal.client, name: e.target.value },
            })
          }
          className="mt-2 w-full bg-transparent text-base font-medium text-zinc-900 outline-none"
        />
        <input
          value={proposal.client.email}
          onChange={(e) =>
            onChange({
              ...proposal,
              client: { ...proposal.client, email: e.target.value },
            })
          }
          className="mt-1 w-full bg-transparent text-sm text-zinc-600 outline-none"
        />

        <ul className="mt-4 space-y-1.5 text-xs text-zinc-500">
          <li className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-accent-600" />
            Email + secure portal link
          </li>
          <li className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-accent-600" />
            Stripe Connect deposit on accept
          </li>
          <li className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-accent-600" />
            Live "viewed" + "accepted" status
          </li>
        </ul>
      </div>
    </aside>
  );
}

function Field({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50/40 px-3 py-2">
      <span>{label}</span>
      <span className="flex items-center gap-1 text-sm font-medium text-zinc-900">
        <input
          type="number"
          step={1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-12 bg-transparent text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {suffix && <span className="text-zinc-500">{suffix}</span>}
      </span>
    </label>
  );
}
