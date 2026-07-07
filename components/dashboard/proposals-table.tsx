"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  ChevronRight,
  Eye,
  Loader2,
  MoreHorizontal,
  Search,
  Send,
  Trash2,
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
import { deleteProposal } from "@/app/actions/proposals";
import type { Proposal } from "@/lib/proposal-mock";

const STATUS_TONE: Record<
  ProposalStatus,
  { tone: Parameters<typeof Badge>[0]["tone"]; label: string }
> = {
  draft: { tone: "neutral", label: "Draft" },
  sent: { tone: "sky", label: "Sent" },
  viewed: { tone: "violet", label: "Viewed" },
  accepted: { tone: "emerald", label: "Accepted" },
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
  // Optimistic hide of deleted rows so the list updates instantly while
  // the server action revalidates the route in the background.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function handleDelete(id: string) {
    setDeletingId(id);
    setDeleteError(null);
    const result = await deleteProposal(id);
    if (result.ok) {
      setDeletedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    } else {
      setDeleteError(result.reason);
    }
    setDeletingId(null);
  }

  const filtered = items.filter((p) => {
    if (deletedIds.has(p.id)) return false;
    if (filter !== "all" && p.status !== filter) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      p.address.toLowerCase().includes(q) ||
      p.client.toLowerCase().includes(q)
    );
  });

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-card">
      {showFilters && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 p-4">
          <div className="flex flex-wrap gap-1.5">
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
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition",
                    active
                      ? "border-zinc-200 bg-zinc-100 font-medium text-zinc-900"
                      : "border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900",
                  )}
                >
                  {f.label}
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] tabular-nums",
                      active
                        ? "bg-white text-zinc-600"
                        : "bg-zinc-100 text-zinc-500",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search address or client…"
              className="input h-9 w-64 pl-9"
            />
          </div>
        </div>
      )}

      <div className="font-label hidden grid-cols-[minmax(0,1fr)_180px_120px_140px_120px_88px] gap-4 px-4 py-2.5 text-[11px] text-zinc-400 lg:grid">
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
        {deleteError && (
          <li className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
            Couldn&apos;t delete: {deleteError}
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
              className="relative border-t border-zinc-100"
            >
              <div className="group grid grid-cols-1 gap-1 px-4 py-3.5 transition hover:bg-zinc-50/60 lg:grid-cols-[minmax(0,1fr)_180px_120px_140px_120px_88px] lg:items-center lg:gap-4">
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
                    <span className="text-[11px] text-emerald-600">
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
                  <RowMenu
                    onDelete={() => handleDelete(p.id)}
                    deleting={deletingId === p.id}
                    address={p.address}
                  />
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

/**
 * Per-row overflow menu — currently delete-only. Confirm step is
 * inline (no separate modal) so it's a single click + a single
 * confirm and the row vanishes.
 */
function RowMenu({
  onDelete,
  deleting,
  address,
}: {
  onDelete: () => void;
  deleting: boolean;
  address: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="More actions"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-zinc-500 transition hover:border-zinc-200 hover:bg-white hover:text-zinc-900"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-elevated"
          onClick={(e) => e.stopPropagation()}
        >
          {!confirming ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirming(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-rose-700 transition hover:bg-rose-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete proposal
            </button>
          ) : (
            <div className="p-3">
              <div className="text-sm font-medium text-zinc-900">
                Delete this proposal?
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {address ? (
                  <>
                    Permanently removes <strong>{address}</strong> and its
                    history.
                  </>
                ) : (
                  "This permanently removes the draft and its history."
                )}{" "}
                Can&apos;t be undone.
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirming(false);
                    setOpen(false);
                  }}
                  className="rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-60"
                >
                  {deleting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
