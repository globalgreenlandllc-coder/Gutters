"use client";

import { motion, AnimatePresence } from "framer-motion";
import { LeadStatus, InteractionStatus } from "@prisma/client";
import { useEffect, useMemo, useState } from "react";
import {
  X,
  MapPin,
  DollarSign,
  Calendar,
  Navigation,
  Copy,
  Check,
  Sparkles,
  Building2,
  HardHat,
  ExternalLink,
  Flame,
  User,
  Wrench,
  Hammer,
  Home,
} from "lucide-react";

export interface LeadWithInteraction {
  id: string;
  sourceCity: string;
  address: string;
  originalDescription: string;
  categorizedTrade: string | null;
  buildingType: string | null;
  projectKind: string | null;
  workClass: string | null;
  fixtures: string | null;
  contractorName: string | null;
  ownerName: string | null;
  aiSummary: string | null;
  aiRelevance: string | null;
  status: LeadStatus;
  latitude: number;
  longitude: number;
  projectValue: number | null;
  issuedDate: string | null;
  housingUnits: number | null;
  developmentType: string | null;
  createdAt?: string;
  interaction: {
    status: InteractionStatus;
    notes: string | null;
  } | null;
}

interface LeadDetailsPanelProps {
  lead: LeadWithInteraction | null;
  onClose: () => void;
  onUpdateInteraction: (leadId: string, status: InteractionStatus, notes: string) => void;
}

const interactionMeta: Record<
  InteractionStatus,
  { label: string; text: string; bg: string; ring: string; dot: string }
> = {
  UNREAD: {
    label: "Unread",
    text: "text-stripe-coral",
    bg: "bg-stripe-coral/10",
    ring: "ring-stripe-coral/40",
    dot: "bg-stripe-coral",
  },
  CONTACTED: {
    label: "Contacted",
    text: "text-emerald-300",
    bg: "bg-emerald-500/10",
    ring: "ring-emerald-500/40",
    dot: "bg-emerald-400",
  },
  VISITED: {
    label: "Visited",
    text: "text-sky-300",
    bg: "bg-sky-500/10",
    ring: "ring-sky-500/40",
    dot: "bg-sky-400",
  },
  BIDDING: {
    label: "Bidding",
    text: "text-amber-300",
    bg: "bg-amber-500/10",
    ring: "ring-amber-500/40",
    dot: "bg-amber-400",
  },
  NOT_INTERESTED: {
    label: "Not interested",
    text: "text-zinc-300",
    bg: "bg-white/5",
    ring: "ring-white/15",
    dot: "bg-zinc-400",
  },
};

const leadStatusMeta: Record<LeadStatus, { label: string; classes: string }> = {
  APPLIED: { label: "Applied", classes: "text-accent-300 bg-accent-500/10 ring-accent-500/30" },
  UNDER_REVIEW: { label: "Under Review", classes: "text-amber-300 bg-amber-500/10 ring-amber-500/30" },
  ISSUED: { label: "Issued", classes: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/30" },
  INSPECTION: { label: "Inspection", classes: "text-sky-300 bg-sky-500/10 ring-sky-500/30" },
  FINALED: { label: "Finaled", classes: "text-zinc-300 bg-white/5 ring-white/15" },
  UNKNOWN: { label: "Unknown", classes: "text-zinc-400 bg-white/5 ring-white/15" },
};

const relevanceMeta: Record<string, { label: string; classes: string; flames: number }> = {
  high: { label: "Hot lead", classes: "text-stripe-coral bg-stripe-coral/10 ring-stripe-coral/40", flames: 3 },
  medium: { label: "Warm lead", classes: "text-amber-300 bg-amber-500/10 ring-amber-500/30", flames: 2 },
  low: { label: "Cold lead", classes: "text-zinc-400 bg-white/5 ring-white/15", flames: 1 },
};

// Build a per-city owner-lookup deep link. Most counties expose a free parcel
// viewer that accepts the property address as a query string.
function ownerLookupUrl(sourceCity: string, address: string): string | null {
  const q = encodeURIComponent(address);
  switch (sourceCity) {
    case "Seattle":
      // King County parcel viewer
      return `https://gismaps.kingcounty.gov/parcelviewer2/?address=${q}`;
    case "San Francisco":
      return `https://sfplanninggis.org/pim/?address=${q}`;
    case "New York":
      return `https://propertyinformationportal.nyc.gov/?address=${q}`;
    case "Los Angeles":
      return `https://assessor.lacounty.gov/?address=${q}`;
    case "Chicago":
      return `https://www.cookcountyassessor.com/search?search_term=${q}`;
    case "Austin":
      return `https://search.tcadcentral.org/?address=${q}`;
    default:
      return null;
  }
}

export default function LeadDetailsPanel({ lead, onClose, onUpdateInteraction }: LeadDetailsPanelProps) {
  const [notes, setNotes] = useState(lead?.interaction?.notes ?? "");
  const [savedFlash, setSavedFlash] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setNotes(lead?.interaction?.notes ?? "");
  }, [lead?.id, lead?.interaction?.notes]);

  // Prefer the actual permit-issue date from the city feed; fall back to
  // our own ingest timestamp if the source didn't publish one.
  const issuedInfo = useMemo(() => {
    const raw = lead?.issuedDate ?? lead?.createdAt;
    if (!raw) return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
    const ago =
      days === 0
        ? "Today"
        : days === 1
        ? "Yesterday"
        : days < 7
        ? `${days}d ago`
        : days < 60
        ? `${Math.round(days / 7)}w ago`
        : `${Math.round(days / 30)}mo ago`;
    const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return { ago, dateStr, isPermitIssueDate: !!lead?.issuedDate };
  }, [lead?.issuedDate, lead?.createdAt]);

  if (!lead) return null;

  const currentStatus = lead.interaction?.status ?? InteractionStatus.UNREAD;
  const statusMeta = interactionMeta[currentStatus];
  const permitMeta = leadStatusMeta[lead.status];

  const handleStatusChange = (status: InteractionStatus) => {
    onUpdateInteraction(lead.id, status, notes);
  };

  const handleSaveNotes = () => {
    onUpdateInteraction(lead.id, currentStatus, notes);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
  };

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(lead.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Copy failed", e);
    }
  };

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lead.latitude},${lead.longitude}`;
  const ownerUrl = ownerLookupUrl(lead.sourceCity, lead.address);
  const contractorSearchUrl = lead.contractorName
    ? `https://www.google.com/search?q=${encodeURIComponent(`${lead.contractorName} ${lead.sourceCity} contractor phone`)}`
    : null;
  const ownerSearchUrl = lead.ownerName
    ? `https://www.google.com/search?q=${encodeURIComponent(`${lead.ownerName} ${lead.sourceCity} phone`)}`
    : null;
  const relevance = lead.aiRelevance && relevanceMeta[lead.aiRelevance] ? relevanceMeta[lead.aiRelevance] : null;

  return (
    <AnimatePresence>
      <motion.div
        key={lead.id}
        initial={{ x: "100%", opacity: 0.6 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 26, stiffness: 220 }}
        className="absolute top-0 right-0 w-[400px] max-w-[100vw] h-full bg-ink border-l border-white/10 shadow-2xl flex flex-col z-50 text-zinc-200"
      >
        {/* Hero header */}
        <div className="relative px-5 pt-5 pb-6 bg-zinc-950 border-b border-white/10">
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="absolute top-3 right-3 p-1.5 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition"
          >
            <X size={18} />
          </button>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            {lead.projectKind && lead.projectKind !== "Other" && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/10 text-violet-300 text-xs font-medium ring-1 ring-violet-500/30">
                <Hammer size={12} />
                {lead.projectKind}
              </span>
            )}
            {lead.developmentType && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-fuchsia-500/10 text-fuchsia-300 text-xs font-medium ring-1 ring-fuchsia-500/30">
                <Home size={12} />
                {lead.developmentType}
                {lead.housingUnits != null && lead.housingUnits > 0 && (
                  <span className="ml-1 px-1 rounded bg-fuchsia-500/20 text-fuchsia-200">
                    {lead.housingUnits}×
                  </span>
                )}
              </span>
            )}
            {lead.buildingType && lead.buildingType !== lead.developmentType && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-500/10 text-sky-300 text-xs font-medium ring-1 ring-sky-500/30">
                <Building2 size={12} />
                {lead.buildingType}
              </span>
            )}
            {lead.categorizedTrade && lead.categorizedTrade !== "Other" && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-500/10 text-accent-300 text-xs font-medium ring-1 ring-accent-500/30">
                <Sparkles size={12} />
                {lead.categorizedTrade}
              </span>
            )}
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ring-1 ${permitMeta.classes}`}>
              {permitMeta.label}
            </span>
            {relevance && (
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ${relevance.classes}`}
                title={`AI-scored relevance for gutter business: ${relevance.label}`}
              >
                {Array.from({ length: relevance.flames }).map((_, i) => (
                  <Flame key={i} size={11} />
                ))}
                {relevance.label}
              </span>
            )}
          </div>

          <h3 className="text-xl font-semibold text-white leading-tight tracking-tight">
            {lead.address}
          </h3>
          <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
            <MapPin size={14} />
            <span>{lead.sourceCity}</span>
            {issuedInfo && (
              <>
                <span className="text-zinc-700">•</span>
                <Calendar size={12} className="text-zinc-500" />
                <span title={issuedInfo.isPermitIssueDate ? `Permit issued ${issuedInfo.dateStr}` : `Indexed ${issuedInfo.dateStr}`}>
                  {issuedInfo.isPermitIssueDate ? "Issued" : "Indexed"} {issuedInfo.ago}
                </span>
              </>
            )}
          </div>

          <div
            className={`mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ring-1 ${statusMeta.bg} ${statusMeta.text} ${statusMeta.ring}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
            {statusMeta.label}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-zinc-900/60 p-3 rounded-xl border border-white/10">
              <div className="font-label text-[10px] text-zinc-500 flex items-center gap-1 mb-1">
                <DollarSign size={11} /> Est. Value
              </div>
              <div className="font-semibold text-white text-base">
                {lead.projectValue ? `$${lead.projectValue.toLocaleString()}` : "—"}
              </div>
            </div>
            <div className="bg-zinc-900/60 p-3 rounded-xl border border-white/10">
              <div className="font-label text-[10px] text-zinc-500 flex items-center gap-1 mb-1">
                <Calendar size={11} /> Issued
              </div>
              <div className="font-semibold text-white text-base truncate" title={issuedInfo?.dateStr}>
                {lead.issuedDate ? issuedInfo?.dateStr : "—"}
              </div>
            </div>
            <div className="bg-zinc-900/60 p-3 rounded-xl border border-white/10">
              <div className="font-label text-[10px] text-zinc-500 flex items-center gap-1 mb-1">
                <Home size={11} /> Units planned
              </div>
              <div className="font-semibold text-white text-base">
                {lead.housingUnits != null && lead.housingUnits > 0
                  ? `${lead.housingUnits} ${lead.housingUnits === 1 ? "unit" : "units"}`
                  : "—"}
              </div>
            </div>
            <div className="bg-zinc-900/60 p-3 rounded-xl border border-white/10">
              <div className="font-label text-[10px] text-zinc-500 flex items-center gap-1 mb-1">
                <Wrench size={11} /> Work
              </div>
              <div className="font-semibold text-white text-base truncate" title={lead.workClass ?? undefined}>
                {lead.workClass ?? lead.projectKind ?? lead.categorizedTrade ?? "—"}
              </div>
            </div>
          </div>

          {/* Parsed fixtures / items involved */}
          {lead.fixtures && (
            <div>
              <h4 className="font-label text-[10px] text-zinc-500 mb-2 flex items-center gap-1.5">
                <Wrench size={11} /> Items in this permit
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {lead.fixtures
                  .split(/,\s*/)
                  .filter(Boolean)
                  .slice(0, 12)
                  .map((f, i) => (
                    <span
                      key={i}
                      className="text-[11px] px-2 py-1 rounded-md bg-zinc-900/80 border border-white/10 text-zinc-300"
                    >
                      {f.trim()}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="grid grid-cols-2 gap-2">
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-sm text-zinc-200 px-3 py-2.5 rounded-xl transition"
            >
              <Navigation size={14} />
              Directions
            </a>
            <button
              onClick={handleCopyAddress}
              className="flex items-center justify-center gap-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-sm text-zinc-200 px-3 py-2.5 rounded-xl transition"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>

          {/* AI summary callout */}
          {lead.aiSummary && (
            <div className="bg-accent-500/10 border border-accent-500/30 p-3 rounded-xl">
              <div className="flex items-center gap-1.5 font-label text-[10px] text-accent-300 mb-1">
                <Sparkles size={11} /> AI Summary
              </div>
              <p className="text-sm text-zinc-200 leading-relaxed">{lead.aiSummary}</p>
            </div>
          )}

          {/* Permit description */}
          <div>
            <h4 className="font-label text-[10px] text-zinc-500 mb-2">
              Original Permit Description
            </h4>
            <div className="bg-zinc-900/60 border border-white/10 p-3 rounded-xl text-sm text-zinc-300 leading-relaxed">
              {lead.originalDescription}
            </div>
          </div>

          {/* Contact paths — owner, contractor, parcel viewer */}
          {(lead.ownerName || lead.contractorName || ownerUrl) && (
            <div>
              <h4 className="font-label text-[10px] text-zinc-500 mb-2">
                Contact Paths
              </h4>
              <div className="space-y-2">
                {lead.ownerName && (
                  <a
                    href={ownerSearchUrl ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 bg-zinc-900/60 hover:bg-zinc-800 border border-white/10 px-3 py-2.5 rounded-xl text-sm text-zinc-200 transition group"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <User size={14} className="text-accent-300 shrink-0" />
                      <span className="flex flex-col min-w-0">
                        <span className="font-label text-[9px] text-zinc-500">Property owner</span>
                        <span className="truncate">{lead.ownerName}</span>
                      </span>
                    </span>
                    <ExternalLink size={13} className="text-zinc-500 group-hover:text-zinc-300 shrink-0" />
                  </a>
                )}
                {lead.contractorName && (
                  <a
                    href={contractorSearchUrl ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 bg-zinc-900/60 hover:bg-zinc-800 border border-white/10 px-3 py-2.5 rounded-xl text-sm text-zinc-200 transition group"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <HardHat size={14} className="text-amber-300 shrink-0" />
                      <span className="flex flex-col min-w-0">
                        <span className="font-label text-[9px] text-zinc-500">Contractor</span>
                        <span className="truncate">{lead.contractorName}</span>
                      </span>
                    </span>
                    <ExternalLink size={13} className="text-zinc-500 group-hover:text-zinc-300 shrink-0" />
                  </a>
                )}
                {ownerUrl && (
                  <a
                    href={ownerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 bg-zinc-900/60 hover:bg-zinc-800 border border-white/10 px-3 py-2.5 rounded-xl text-sm text-zinc-200 transition group"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Building2 size={14} className="text-sky-300 shrink-0" />
                      <span className="flex flex-col min-w-0">
                        <span className="font-label text-[9px] text-zinc-500">Parcel records</span>
                        <span className="truncate">County parcel viewer</span>
                      </span>
                    </span>
                    <ExternalLink size={13} className="text-zinc-500 group-hover:text-zinc-300 shrink-0" />
                  </a>
                )}
              </div>
            </div>
          )}

          {/* CRM status segmented control */}
          <div>
            <h4 className="font-label text-[10px] text-zinc-500 mb-2">
              Your Status
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(interactionMeta) as InteractionStatus[]).map((s) => {
                const m = interactionMeta[s];
                const active = currentStatus === s;
                return (
                  <button
                    key={s}
                    onClick={() => handleStatusChange(s)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ring-1 ${
                      active
                        ? `${m.bg} ${m.text} ${m.ring}`
                        : "bg-zinc-900 text-zinc-400 ring-white/10 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${active ? m.dot : "bg-zinc-600"}`} />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-label text-[10px] text-zinc-500">
                Private Notes
              </h4>
              {savedFlash && (
                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <Check size={11} /> Saved
                </span>
              )}
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add notes about this lead..."
              className="w-full bg-zinc-900/60 border border-white/10 rounded-xl p-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-accent-500/50 focus:border-transparent transition resize-none"
              rows={4}
            />
            <button
              onClick={handleSaveNotes}
              className="mt-2 w-full bg-accent-600 hover:bg-accent-500 text-white text-sm font-medium py-2 rounded-lg transition"
            >
              Save Notes
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
