"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  Clock,
  FileDiff,
  Hourglass,
  ListChecks,
  Mail,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AttentionItem } from "@/app/actions/payments";

const KIND_ICON: Record<
  AttentionItem["kind"],
  React.ComponentType<{ className?: string }>
> = {
  overdue_payment: AlertTriangle,
  awaiting_deposit: Hourglass,
  pending_change_order: FileDiff,
  expiring_proposal: Clock,
  stale_draft: Mail,
  unopened_proposal: Mail,
};

const URGENCY_STYLE: Record<AttentionItem["urgency"], string> = {
  high: "bg-rose-50 text-rose-600",
  medium: "bg-amber-50 text-amber-600",
  low: "bg-zinc-100 text-zinc-500",
};

/**
 * The smart to-do card on the Overview: overdue money, change orders
 * waiting on clients, proposals about to expire — ranked by urgency,
 * each row deep-linking to the exact place to fix it.
 */
export function NeedsAttention({
  items,
  loading,
}: {
  items: AttentionItem[];
  loading?: boolean;
}) {
  return (
    <div className="surface shadow-card">
      <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
        <h3 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900">
          <Bell className="h-4 w-4 text-zinc-400" />
          Needs attention
        </h3>
        {items.length > 0 && (
          <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-600">
            {items.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-zinc-100" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <div className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="mt-3 text-sm font-medium text-zinc-900">
            All clear
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            No overdue payments, pending approvals or expiring proposals.
          </p>
        </div>
      ) : (
        <ul>
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind] ?? ListChecks;
            return (
              <li key={item.id} className="border-b border-zinc-100 last:border-b-0">
                <Link
                  href={item.href}
                  className="group flex items-center gap-3 px-5 py-3 transition hover:bg-zinc-50/70"
                >
                  <span
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                      URGENCY_STYLE[item.urgency],
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-900">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">
                      {item.detail}
                    </span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
