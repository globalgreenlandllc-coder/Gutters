"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  Flame,
  Home,
  Building2,
  Hammer,
  Wrench,
  Trash2,
  Sparkles,
  Loader2,
  Inbox,
  Calendar,
  DollarSign,
} from "lucide-react";
import { InteractionStatus } from "@prisma/client";
import type { LeadWithInteraction } from "./LeadDetailsPanel";

export type SortMode = "relevance" | "newest" | "value";

const RELEVANCE_META: Record<
  string,
  { label: string; dot: string; text: string; ring: string }
> = {
  high: {
    label: "Hot",
    dot: "bg-stripe-coral",
    text: "text-stripe-coral",
    ring: "ring-stripe-coral/40",
  },
  medium: {
    label: "Warm",
    dot: "bg-amber-400",
    text: "text-amber-300",
    ring: "ring-amber-500/40",
  },
  low: {
    label: "Cold",
    dot: "bg-sky-400",
    text: "text-sky-300",
    ring: "ring-sky-500/40",
  },
};

const INTERACTION_PILL: Record<
  InteractionStatus,
  { label: string; cls: string }
> = {
  UNREAD: {
    label: "New",
    cls: "bg-stripe-coral/15 text-stripe-coral ring-stripe-coral/40",
  },
  CONTACTED: {
    label: "Contacted",
    cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  },
  VISITED: {
    label: "Visited",
    cls: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  },
  BIDDING: {
    label: "Bidding",
    cls: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  },
  NOT_INTERESTED: {
    label: "Skip",
    cls: "bg-white/5 text-zinc-400 ring-white/10",
  },
};

function pickIcon(lead: LeadWithInteraction) {
  const pk = lead.projectKind ?? "";
  const dt = lead.developmentType ?? "";
  if (pk === "Demolition") return Trash2;
  if (pk === "New Construction") {
    if (dt === "Multifamily" || dt === "Condo" || dt === "Townhouse")
      return Building2;
    return Home;
  }
  if (dt === "Multifamily" || dt === "Condo") return Building2;
  if (lead.aiRelevance === "high") return Flame;
  if (pk === "Remodel/Addition") return Wrench;
  return Sparkles;
}

function daysSince(iso?: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / (24 * 3600 * 1000));
  if (days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatMoney(v: number | null): string | null {
  if (v == null || v <= 0) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${v}`;
}

export interface LeadsSidebarHandle {
  scrollLeadIntoView: (leadId: string) => void;
}

interface LeadsSidebarProps {
  leads: LeadWithInteraction[];
  hoveredLeadId: string | null;
  selectedLeadId: string | null;
  onHover: (lead: LeadWithInteraction | null) => void;
  onSelect: (lead: LeadWithInteraction) => void;
  isLoading: boolean;
  hasMore: boolean;
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const LeadsSidebar = forwardRef<LeadsSidebarHandle, LeadsSidebarProps>(
  function LeadsSidebar(
    {
      leads,
      hoveredLeadId,
      selectedLeadId,
      onHover,
      onSelect,
      isLoading,
      hasMore,
      sort,
      onSortChange,
      collapsed,
      onToggleCollapse,
    },
    ref,
  ) {
    const listRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    useImperativeHandle(
      ref,
      (): LeadsSidebarHandle => ({
        scrollLeadIntoView(leadId) {
          const el = cardRefs.current.get(leadId);
          if (!el || !listRef.current) return;
          // Use the nearest-scroll behavior so the list doesn't jump if
          // the card is already partially visible.
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        },
      }),
    );

    // When the SELECTED lead changes via marker click, auto-scroll it
    // into view in the sidebar so the user can confirm what they picked.
    useEffect(() => {
      if (!selectedLeadId) return;
      const el = cardRefs.current.get(selectedLeadId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, [selectedLeadId]);

    if (collapsed) {
      return (
        <aside className="flex w-12 flex-col items-center border-r border-white/10 bg-ink py-3">
          <button
            onClick={onToggleCollapse}
            title="Show leads list"
            className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white"
          >
            <Inbox size={18} />
          </button>
          <div className="mt-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200 tabular-nums">
            {leads.length}
          </div>
        </aside>
      );
    }

    return (
      <aside className="flex h-full w-[380px] shrink-0 flex-col border-r border-white/10 bg-ink">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-white tabular-nums">
              {isLoading ? "…" : leads.length}
            </span>
            <span className="text-xs text-zinc-400">
              {leads.length === 1 ? "lead" : "leads"} in view
              {hasMore && " (top 500)"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <select
              value={sort}
              onChange={(e) => onSortChange(e.target.value as SortMode)}
              className="rounded-md border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-accent-500"
              title="Sort leads"
            >
              <option value="relevance">Hot first</option>
              <option value="newest">Newest</option>
              <option value="value">Highest value</option>
            </select>
            <button
              onClick={onToggleCollapse}
              title="Hide list"
              className="rounded-md p-1 text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <Inbox size={14} />
            </button>
          </div>
        </div>

        {/* Body — scrollable list */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto overscroll-contain"
        >
          {isLoading && leads.length === 0 ? (
            <div className="flex h-full items-center justify-center text-zinc-500">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : leads.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <Inbox size={32} className="text-zinc-700" />
              <p className="mt-2 text-sm font-medium text-zinc-300">
                No leads here
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Pan or zoom the map, or loosen the filters.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {leads.map((lead) => (
                <li key={lead.id}>
                  <LeadCard
                    lead={lead}
                    isHovered={hoveredLeadId === lead.id}
                    isSelected={selectedLeadId === lead.id}
                    onHover={onHover}
                    onSelect={onSelect}
                    registerRef={(el) => {
                      if (el) cardRefs.current.set(lead.id, el);
                      else cardRefs.current.delete(lead.id);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    );
  },
);

export default LeadsSidebar;

interface LeadCardProps {
  lead: LeadWithInteraction;
  isHovered: boolean;
  isSelected: boolean;
  onHover: (lead: LeadWithInteraction | null) => void;
  onSelect: (lead: LeadWithInteraction) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

function LeadCard({
  lead,
  isHovered,
  isSelected,
  onHover,
  onSelect,
  registerRef,
}: LeadCardProps) {
  const Icon = pickIcon(lead);
  const rel = lead.aiRelevance ? RELEVANCE_META[lead.aiRelevance] : null;
  const interactionMeta = lead.interaction
    ? INTERACTION_PILL[lead.interaction.status]
    : null;
  const value = formatMoney(lead.projectValue);
  const age = daysSince(lead.issuedDate);

  return (
    <button
      ref={registerRef}
      onMouseEnter={() => onHover(lead)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(lead)}
      className={`group block w-full px-4 py-3 text-left transition ${
        isSelected
          ? "bg-accent-500/10 ring-1 ring-inset ring-accent-500/40"
          : isHovered
            ? "bg-white/[0.06]"
            : "hover:bg-white/[0.04]"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ${
            rel
              ? `${rel.ring} bg-zinc-950`
              : "bg-zinc-900 ring-white/10"
          }`}
        >
          <Icon
            size={16}
            className={rel ? rel.text : "text-zinc-300"}
            strokeWidth={2.5}
          />
        </div>
        <div className="min-w-0 flex-1">
          {/* Top row: relevance + value */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {rel && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${rel.ring} ${rel.text} bg-zinc-950`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${rel.dot}`} />
                  {rel.label}
                </span>
              )}
              {interactionMeta && (
                <span
                  className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${interactionMeta.cls}`}
                >
                  {interactionMeta.label}
                </span>
              )}
            </div>
            {value && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums text-accent-300">
                <DollarSign size={10} className="opacity-70" />
                {value.replace("$", "")}
              </span>
            )}
          </div>

          {/* Address */}
          <div className="mt-1 truncate text-sm font-medium text-white">
            {lead.address}
          </div>

          {/* Subline: kind • dev • city */}
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
            {lead.projectKind && lead.projectKind !== "Other" && (
              <>
                <span className="truncate">{lead.projectKind}</span>
                {(lead.developmentType ||
                  lead.sourceCity ||
                  age) && <span className="text-zinc-600">·</span>}
              </>
            )}
            {lead.developmentType && (
              <>
                <span className="truncate">
                  {lead.developmentType}
                  {lead.housingUnits && lead.housingUnits > 1
                    ? ` (${lead.housingUnits}u)`
                    : ""}
                </span>
                {(lead.sourceCity || age) && (
                  <span className="text-zinc-600">·</span>
                )}
              </>
            )}
            <span className="truncate text-zinc-500">{lead.sourceCity}</span>
            {age && (
              <>
                <span className="text-zinc-600">·</span>
                <span className="inline-flex items-center gap-0.5">
                  <Calendar size={9} className="opacity-60" />
                  {age}
                </span>
              </>
            )}
          </div>

          {/* AI summary preview */}
          {lead.aiSummary && (
            <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-zinc-300/80">
              {lead.aiSummary}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
