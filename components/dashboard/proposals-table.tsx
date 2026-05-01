"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  ChevronRight,
  Eye,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency } from "@/lib/utils";
import {
  timeAgo,
  type ProposalListItem,
  type ProposalStatus,
} from "@/lib/dashboard-mock";

const STATUS_TONE: Record<
  ProposalStatus,
  { tone: Parameters<typeof Badge>[0]["tone"]; label: string }
> = {
  draft: { tone: "neutral", label: "Draft" },
  sent: { tone: "sky", label: "Sent" },
  viewed: { tone: "violet", label: "Viewed" },
  accepted: { tone: "accent", label: "Accepted" },
  declined: { tone: "rose", label: "Declined" },
  expired: { tone: "amber", label: "Expired" },
};

const FILTERS: { id: "all" | ProposalStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "sent", label: "Sent" },
  { id: "viewed", label: "Viewed" },
  { id: "accepted", label: "Accepted" },
  { id: "expired", label: "Expired" },
];

export function ProposalsTable({
  items,
  compact = false,
  showFilters = true,
}: {
  items: ProposalListItem[];
  compact?: boolean;
  showFilters?: boolean;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");

  const filtered = items.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      p.address.toLowerCase().includes(q) ||
      p.client.toLowerCase().includes(q)
    );
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card">
      {showFilters && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 p-4">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => {
              const count =
                f.id === "all"
                  ? items.length
                  : items.filter((p) => p.status === f.id).length;
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition",
                    active
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-600 hover:bg-zinc-100",
                  )}
                >
                  {f.label}
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[10px] tabular-nums",
                      active ? "bg-white/15 text-white" : "bg-zinc-100 text-zinc-500",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative flex h-9 items-center rounded-lg border border-zinc-200 bg-white px-3 text-sm transition focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/15">
            <Search className="mr-2 h-4 w-4 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search address or client…"
              className="w-56 bg-transparent text-zinc-900 outline-none placeholder:text-zinc-400"
            />
          </div>
        </div>
      )}

      <div className="hidden grid-cols-[minmax(0,1fr)_180px_120px_120px_120px_44px] gap-4 border-b border-zinc-100 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500 lg:grid">
        <div>Property · Client</div>
        <div>Status</div>
        <div className="text-right">Total</div>
        <div className="text-center">Views</div>
        <div className="text-right">Updated</div>
        <div />
      </div>

      <ul>
        {filtered.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-zinc-500">
            No proposals match these filters.
          </li>
        )}
        {filtered.map((p, i) => {
          const tone = STATUS_TONE[p.status];
          return (
            <motion.li
              key={p.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: Math.min(i, 8) * 0.02 }}
              className="border-b border-zinc-100 last:border-0"
            >
              <Link
                href={`/proposal?id=${p.id}`}
                className="grid grid-cols-1 gap-1 px-4 py-3 transition hover:bg-zinc-50 lg:grid-cols-[minmax(0,1fr)_180px_120px_120px_120px_44px] lg:items-center lg:gap-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-zinc-900">
                    {p.address}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    {p.client}
                    {p.selectedPackage && (
                      <span className="ml-1 text-zinc-400">
                        · {p.selectedPackage}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={tone.tone}>{tone.label}</Badge>
                  {p.status === "accepted" && p.paid !== undefined && (
                    <span className="text-[11px] text-accent-700">
                      paid {formatCurrency(p.paid)}
                    </span>
                  )}
                </div>
                <div className="text-right text-sm font-medium tabular-nums text-zinc-900">
                  {formatCurrency(p.total)}
                </div>
                <div className="flex items-center justify-center gap-1 text-xs text-zinc-500">
                  <Eye className="h-3 w-3" />
                  <span className="tabular-nums">{p.views}</span>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  {timeAgo(p.updatedAt)}
                </div>
                <ChevronRight className="hidden h-4 w-4 justify-self-end text-zinc-300 lg:block" />
              </Link>
            </motion.li>
          );
        })}
      </ul>

      {compact && (
        <div className="border-t border-zinc-100 p-3 text-center">
          <Link
            href="/dashboard/proposals"
            className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:text-accent-800"
          >
            View all proposals
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}
