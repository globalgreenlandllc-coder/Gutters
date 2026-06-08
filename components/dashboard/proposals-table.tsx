"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  ChevronRight,
  Eye,
  Loader2,
  Send,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency } from "@/lib/utils";
import {
  timeAgo,
  type ProposalListItem,
  type ProposalStatus,
} from "@/lib/dashboard-mock";
import { SendModal } from "@/components/proposal/send-modal";
import { getMyProposal } from "@/app/actions/dashboard";
import type { Proposal } from "@/lib/proposal-mock";

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
  // Send-from-list: when the row's Send button is clicked, we load the
  // full Proposal blob from the DB and pop the same SendModal the
  // /proposal editor uses. Loading state is per-row so multiple rows
  // can be Send-clicked in quick succession without spinning the wrong one.
  const [loadingSendId, setLoadingSendId] = useState<string | null>(null);
  const [sendProposal, setSendProposal] = useState<Proposal | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  async function openSendFor(id: string) {
    setLoadingSendId(id);
    setSendError(null);
    try {
      const loaded = await getMyProposal(id);
      if (!loaded) {
        setSendError("Proposal not found.");
        return;
      }
      setSendProposal(loaded);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to load proposal");
    } finally {
      setLoadingSendId(null);
    }
  }

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

      <div className="hidden grid-cols-[minmax(0,1fr)_180px_120px_140px_120px_88px] gap-4 border-b border-zinc-100 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500 lg:grid">
        <div>Property · Client</div>
        <div>Status</div>
        <div className="text-right">Total</div>
        <div className="text-center">Client views</div>
        <div className="text-right">Updated</div>
        <div className="text-right">Actions</div>
      </div>

      <ul>
        {filtered.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-zinc-500">
            No proposals match these filters.
          </li>
        )}
        {sendError && (
          <li className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
            {sendError}
          </li>
        )}
        {filtered.map((p, i) => {
          const tone = STATUS_TONE[p.status];
          // Send is meaningful for drafts and re-sends; suppress only
          // for accepted / declined / expired where it'd be misleading.
          const canSend =
            p.status === "draft" ||
            p.status === "sent" ||
            p.status === "viewed";
          const viewCount = p.viewCount ?? 0;
          const lastViewed = p.lastViewedAt;
          return (
            <motion.li
              key={p.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: Math.min(i, 8) * 0.02 }}
              className="relative border-b border-zinc-100 last:border-0"
            >
              <div className="group grid grid-cols-1 gap-1 px-4 py-3 transition hover:bg-zinc-50 lg:grid-cols-[minmax(0,1fr)_180px_120px_140px_120px_88px] lg:items-center lg:gap-4">
                <Link
                  href={`/proposal?id=${p.id}`}
                  className="min-w-0"
                >
                  <div className="truncate font-medium text-zinc-900">
                    {p.address || (
                      <span className="text-zinc-400">(no address)</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    {p.client || (
                      <span className="text-zinc-400">(no client)</span>
                    )}
                    {p.selectedPackage && (
                      <span className="ml-1 text-zinc-400">
                        · {p.selectedPackage}
                      </span>
                    )}
                  </div>
                </Link>
                <Link
                  href={`/proposal?id=${p.id}`}
                  className="flex items-center gap-2"
                >
                  <Badge tone={tone.tone}>{tone.label}</Badge>
                  {p.status === "accepted" && p.paid !== undefined && (
                    <span className="text-[11px] text-accent-700">
                      paid {formatCurrency(p.paid)}
                    </span>
                  )}
                </Link>
                <Link
                  href={`/proposal?id=${p.id}`}
                  className="text-right text-sm font-medium tabular-nums text-zinc-900"
                >
                  {formatCurrency(p.total)}
                </Link>
                <Link
                  href={`/proposal?id=${p.id}`}
                  className="flex items-center justify-center gap-1.5"
                  title={
                    lastViewed
                      ? `First viewed ${timeAgo(p.firstViewedAt ?? lastViewed)}, last ${timeAgo(lastViewed)}`
                      : viewCount === 0
                        ? "Not opened yet"
                        : undefined
                  }
                >
                  {viewCount === 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
                      <Eye className="h-3 w-3" />
                      Not opened
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-inset ring-violet-200">
                      <Eye className="h-3 w-3" />
                      <span className="tabular-nums">{viewCount}×</span>
                      {lastViewed && (
                        <span className="text-violet-500/80">
                          · {timeAgo(lastViewed)}
                        </span>
                      )}
                    </span>
                  )}
                </Link>
                <Link
                  href={`/proposal?id=${p.id}`}
                  className="text-right text-xs text-zinc-500"
                >
                  {timeAgo(p.updatedAt)}
                </Link>
                <div className="flex items-center justify-end gap-1">
                  {canSend && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openSendFor(p.id);
                      }}
                      disabled={loadingSendId === p.id}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition hover:border-accent-400 hover:bg-accent-50 hover:text-accent-700 disabled:opacity-60"
                      title={
                        p.status === "draft"
                          ? "Send proposal to client"
                          : "Re-send proposal"
                      }
                    >
                      {loadingSendId === p.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      {p.status === "draft" ? "Send" : "Re-send"}
                    </button>
                  )}
                  <ChevronRight className="hidden h-4 w-4 text-zinc-300 lg:block" />
                </div>
              </div>
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
      {sendProposal && (
        <SendModal
          open
          onClose={() => setSendProposal(null)}
          proposal={sendProposal}
        />
      )}
    </div>
  );
}
