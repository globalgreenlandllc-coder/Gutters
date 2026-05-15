"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMap,
} from "@vis.gl/react-google-maps";
import { InteractionStatus, LeadStatus } from "@prisma/client";
import {
  Loader2,
  Search,
  Flame,
  Home,
  Building2,
  Hammer,
  Inbox,
  SlidersHorizontal,
  X,
  Trash2,
  Wrench,
  Sparkles,
} from "lucide-react";
import LeadDetailsPanel, { LeadWithInteraction } from "./LeadDetailsPanel";

const BBOX_DEBOUNCE_MS = 400;

// Filter state shape — single object makes preset application atomic and
// makes derivation of active chips a one-liner.
interface FilterState {
  trade: string;
  status: LeadStatus | "All";
  interactionStatus: InteractionStatus | "All";
  buildingType: string;
  projectKind: string;
  developmentType: string;
  relevance: string;
  stage: string;
}

const DEFAULT_FILTERS: FilterState = {
  trade: "All",
  status: "All",
  interactionStatus: "All",
  buildingType: "All",
  projectKind: "All",
  developmentType: "All",
  relevance: "All",
  // Default to "last 12 months" — old finished projects are rarely
  // actionable. User can pick "All time" or a narrower stage band.
  stage: "last-12-months",
};

// Friendly labels for stage values. Cumulative ranges — each one INCLUDES
// the narrower options below it so picking a longer window strictly shows
// more leads.
const STAGE_LABELS: Record<string, string> = {
  "all": "All time",
  "last-30-days": "Last 30 days",
  "last-90-days": "Last 3 months",
  "last-180-days": "Last 6 months",
  "last-12-months": "Last 12 months",
  "older-than-12-months": "Older than 12 months",
};

type PresetId =
  | "hot-builds"
  | "sfd-remodels"
  | "new-homes"
  | "commercial-builds"
  | "townhouses-plats"
  | "unread";

interface Preset {
  id: PresetId;
  label: string;
  Icon: typeof Flame;
  patch: Partial<FilterState>;
}

const PRESETS: Preset[] = [
  {
    id: "hot-builds",
    label: "Hot builds",
    Icon: Flame,
    patch: { projectKind: "New Construction", relevance: "high" },
  },
  {
    id: "new-homes",
    label: "New homes",
    Icon: Home,
    patch: { buildingType: "Residential", projectKind: "New Construction" },
  },
  {
    id: "sfd-remodels",
    label: "SFD remodels",
    Icon: Hammer,
    patch: { buildingType: "Single Family/Duplex", projectKind: "Remodel/Addition" },
  },
  {
    id: "commercial-builds",
    label: "Commercial",
    Icon: Building2,
    patch: { buildingType: "Commercial", projectKind: "New Construction" },
  },
  {
    id: "townhouses-plats",
    label: "Townhouses & plats",
    Icon: Hammer,
    patch: { developmentType: "Townhouse" },
  },
  {
    id: "unread",
    label: "Unread",
    Icon: Inbox,
    patch: { interactionStatus: InteractionStatus.UNREAD },
  },
];

// Returns true when the current filter state EXACTLY matches a preset's patch
// (all preset keys equal the patch, all other keys at default).
function isPresetActive(preset: Preset, current: FilterState): boolean {
  for (const k of Object.keys(DEFAULT_FILTERS) as (keyof FilterState)[]) {
    const expected = (preset.patch[k] ?? DEFAULT_FILTERS[k]) as string;
    if (current[k] !== expected) return false;
  }
  return true;
}

// Build the list of human-readable active filter chips for display.
function buildActiveChips(
  current: FilterState,
  updaters: {
    setTrade: (v: string) => void;
    setStatus: (v: LeadStatus | "All") => void;
    setInteraction: (v: InteractionStatus | "All") => void;
    setBuilding: (v: string) => void;
    setProject: (v: string) => void;
    setDevelopment: (v: string) => void;
    setStage: (v: string) => void;
    setRelevance: (v: string) => void;
  },
) {
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (current.relevance !== "All") {
    const labelMap: Record<string, string> = { high: "Hot", medium: "Warm", low: "Cold" };
    chips.push({
      key: "relevance",
      label: `${labelMap[current.relevance] ?? current.relevance} leads`,
      clear: () => updaters.setRelevance("All"),
    });
  }
  if (current.projectKind !== "All") {
    chips.push({
      key: "projectKind",
      label: current.projectKind,
      clear: () => updaters.setProject("All"),
    });
  }
  if (current.buildingType !== "All") {
    const labelMap: Record<string, string> = { Residential: "Residential (any)" };
    chips.push({
      key: "buildingType",
      label: labelMap[current.buildingType] ?? current.buildingType,
      clear: () => updaters.setBuilding("All"),
    });
  }
  if (current.developmentType !== "All") {
    chips.push({
      key: "developmentType",
      label: current.developmentType,
      clear: () => updaters.setDevelopment("All"),
    });
  }
  if (current.stage !== DEFAULT_FILTERS.stage) {
    chips.push({
      key: "stage",
      label: STAGE_LABELS[current.stage] ?? current.stage,
      clear: () => updaters.setStage(DEFAULT_FILTERS.stage),
    });
  }
  if (current.trade !== "All") {
    chips.push({
      key: "trade",
      label: current.trade,
      clear: () => updaters.setTrade("All"),
    });
  }
  if (current.interactionStatus !== "All") {
    chips.push({
      key: "interactionStatus",
      label: `My: ${String(current.interactionStatus).replace(/_/g, " ").toLowerCase()}`,
      clear: () => updaters.setInteraction("All"),
    });
  }
  if (current.status !== "All") {
    chips.push({
      key: "status",
      label: String(current.status).replace(/_/g, " ").toLowerCase(),
      clear: () => updaters.setStatus("All"),
    });
  }
  return chips;
}

interface MapControlsProps {
  filters: FilterState;
  setTradeFilter: (v: string) => void;
  setStatusFilter: (v: LeadStatus | "All") => void;
  setInteractionFilter: (v: InteractionStatus | "All") => void;
  setBuildingTypeFilter: (v: string) => void;
  setProjectKindFilter: (v: string) => void;
  setDevelopmentTypeFilter: (v: string) => void;
  setStageFilter: (v: string) => void;
  setRelevanceFilter: (v: string) => void;
  applyPreset: (preset: Preset) => void;
  clearAll: () => void;
  onSearch: (bbox: string | null) => void;
  isLoading: boolean;
}

function MapControls({
  filters,
  setTradeFilter,
  setStatusFilter,
  setInteractionFilter,
  setBuildingTypeFilter,
  setProjectKindFilter,
  setDevelopmentTypeFilter,
  setStageFilter,
  setRelevanceFilter,
  applyPreset,
  clearAll,
  onSearch,
  isLoading,
}: MapControlsProps) {
  const map = useMap();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const handleSearchClick = () => {
    if (!map) return onSearch(null);
    const bounds = map.getBounds();
    if (!bounds) return onSearch(null);
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    onSearch(`${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`);
  };

  const chips = buildActiveChips(filters, {
    setTrade: setTradeFilter,
    setStatus: setStatusFilter,
    setInteraction: setInteractionFilter,
    setBuilding: setBuildingTypeFilter,
    setProject: setProjectKindFilter,
    setDevelopment: setDevelopmentTypeFilter,
    setStage: setStageFilter,
    setRelevance: setRelevanceFilter,
  });
  const activeCount = chips.length;

  const selectBase =
    "bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500";

  return (
    <div className="absolute top-4 left-4 right-4 sm:right-auto z-10 bg-slate-900/95 backdrop-blur-md rounded-2xl border border-slate-800 shadow-2xl overflow-hidden max-w-[min(900px,calc(100vw-2rem))]">
      {/* Row 1: Presets + Search button */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-slate-800/60">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-1">
          Quick
        </span>
        {PRESETS.map((p) => {
          const active = isPresetActive(p, filters);
          return (
            <button
              key={p.id}
              onClick={() => (active ? clearAll() : applyPreset(p))}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition ring-1 ${
                active
                  ? "bg-emerald-500/15 text-emerald-200 ring-emerald-500/50"
                  : "bg-slate-800/70 text-slate-300 ring-slate-700 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <p.Icon size={12} />
              {p.label}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition ring-1 ${
            advancedOpen
              ? "bg-slate-800 text-white ring-slate-700"
              : "bg-slate-900/70 text-slate-300 ring-slate-800 hover:text-white"
          }`}
        >
          <SlidersHorizontal size={12} />
          Filters{activeCount > 0 && ` (${activeCount})`}
        </button>
        <button
          onClick={handleSearchClick}
          disabled={isLoading}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition inline-flex items-center gap-1.5"
        >
          {isLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          Search this area
        </button>
      </div>

      {/* Row 2: Advanced filters (collapsible) */}
      {advancedOpen && (
        <div className="flex flex-wrap gap-2 px-3 py-2.5 border-b border-slate-800/60">
          <select
            className={selectBase}
            value={filters.projectKind}
            onChange={(e) => setProjectKindFilter(e.target.value)}
          >
            <option value="All">All project types</option>
            <option value="New Construction">New Construction</option>
            <option value="Remodel/Addition">Remodel / Addition</option>
            <option value="Tenant Improvement">Tenant Improvement</option>
            <option value="Demolition">Demolition</option>
            <option value="Other">Other</option>
          </select>
          <select
            className={selectBase}
            value={filters.buildingType}
            onChange={(e) => setBuildingTypeFilter(e.target.value)}
          >
            <option value="All">All building types</option>
            <option value="Residential">Residential (any)</option>
            <option value="Single Family/Duplex">Single Family / Duplex</option>
            <option value="Multifamily">Multifamily</option>
            <option value="Commercial">Commercial</option>
            <option value="Institutional">Institutional</option>
            <option value="Industrial">Industrial</option>
          </select>
          <select
            className={selectBase}
            value={filters.developmentType}
            onChange={(e) => setDevelopmentTypeFilter(e.target.value)}
          >
            <option value="All">All development types</option>
            <option value="Single Family">Single Family</option>
            <option value="Duplex">Duplex</option>
            <option value="Townhouse">Townhouse</option>
            <option value="Condo">Condo</option>
            <option value="Multifamily">Multifamily</option>
            <option value="ADU">ADU / DADU</option>
            <option value="Plat">Plat</option>
            <option value="Short Plat">Short Plat</option>
          </select>
          <select
            className={selectBase}
            value={filters.stage}
            onChange={(e) => setStageFilter(e.target.value)}
            title="Approximates how far along construction is, based on how long ago the permit was issued."
          >
            {Object.entries(STAGE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select
            className={selectBase}
            value={filters.relevance}
            onChange={(e) => setRelevanceFilter(e.target.value)}
          >
            <option value="All">Any relevance</option>
            <option value="high">Hot leads</option>
            <option value="medium">Warm leads</option>
            <option value="low">Cold leads</option>
          </select>
          <select
            className={selectBase}
            value={filters.trade}
            onChange={(e) => setTradeFilter(e.target.value)}
          >
            <option value="All">All trades</option>
            <option value="Roofing">Roofing</option>
            <option value="Gutters">Gutters</option>
            <option value="Framing">Framing</option>
            <option value="Siding">Siding</option>
            <option value="Windows">Windows</option>
            <option value="General">General</option>
          </select>
          <select
            className={selectBase}
            value={filters.interactionStatus}
            onChange={(e) =>
              setInteractionFilter(e.target.value as InteractionStatus | "All")
            }
          >
            <option value="All">All my statuses</option>
            <option value={InteractionStatus.UNREAD}>Unread</option>
            <option value={InteractionStatus.CONTACTED}>Contacted</option>
            <option value={InteractionStatus.VISITED}>Visited</option>
            <option value={InteractionStatus.BIDDING}>Bidding</option>
            <option value={InteractionStatus.NOT_INTERESTED}>Not interested</option>
          </select>
          <select
            className={selectBase}
            value={filters.status}
            onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "All")}
          >
            <option value="All">All permit statuses</option>
            <option value={LeadStatus.APPLIED}>Applied</option>
            <option value={LeadStatus.UNDER_REVIEW}>Under Review</option>
            <option value={LeadStatus.ISSUED}>Issued</option>
            <option value={LeadStatus.INSPECTION}>Inspection</option>
            <option value={LeadStatus.FINALED}>Finaled</option>
            <option value={LeadStatus.UNKNOWN}>Unknown</option>
          </select>
        </div>
      )}

      {/* Row 3: Active filter chips */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 bg-slate-900/40">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-1">
            Active
          </span>
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={c.clear}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/40 hover:bg-emerald-500/25 transition"
            >
              {c.label}
              <X size={10} />
            </button>
          ))}
          <button
            onClick={clearAll}
            className="ml-1 text-[11px] text-slate-400 hover:text-white underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

export default function LeadsMap({ apiKey }: { apiKey: string }) {
  const [leads, setLeads] = useState<LeadWithInteraction[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithInteraction | null>(null);
  const [hoveredLead, setHoveredLead] = useState<LeadWithInteraction | null>(null);
  const [bbox, setBbox] = useState<string>("");
  const [tradeFilter, setTradeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "All">("All");
  const [interactionFilter, setInteractionFilter] = useState<InteractionStatus | "All">("All");
  const [buildingTypeFilter, setBuildingTypeFilter] = useState("All");
  const [projectKindFilter, setProjectKindFilter] = useState("All");
  const [developmentTypeFilter, setDevelopmentTypeFilter] = useState("All");
  const [stageFilter, setStageFilter] = useState<string>(DEFAULT_FILTERS.stage);
  const [relevanceFilter, setRelevanceFilter] = useState("All");
  const [isLoading, setIsLoading] = useState(false);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const bboxDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single source of truth for fetching. Caller can pass a bbox override so
  // the "Search this area" button can use the LIVE map bounds without waiting
  // for the debounced state propagation.
  const fetchLeads = useCallback(
    async (overrideBbox?: string) => {
      const effectiveBbox = overrideBbox ?? bbox;
      setIsLoading(true);
      try {
        const url = new URL("/api/leads", window.location.origin);
        if (effectiveBbox) url.searchParams.set("bbox", effectiveBbox);
        if (tradeFilter !== "All") url.searchParams.set("trade", tradeFilter);
        if (statusFilter !== "All") url.searchParams.set("status", statusFilter);
        if (interactionFilter !== "All") {
          url.searchParams.set("interactionStatus", interactionFilter);
        }
        if (buildingTypeFilter !== "All") {
          url.searchParams.set("buildingType", buildingTypeFilter);
        }
        if (projectKindFilter !== "All") {
          url.searchParams.set("projectKind", projectKindFilter);
        }
        if (developmentTypeFilter !== "All") {
          url.searchParams.set("developmentType", developmentTypeFilter);
        }
        if (stageFilter && stageFilter !== DEFAULT_FILTERS.stage) {
          url.searchParams.set("stage", stageFilter);
        } else if (stageFilter === DEFAULT_FILTERS.stage) {
          // Send the default explicitly so the server's default and the
          // client's default stay in sync if either changes.
          url.searchParams.set("stage", stageFilter);
        }
        if (relevanceFilter !== "All") {
          url.searchParams.set("relevance", relevanceFilter);
        }

        const res = await fetch(url.toString());
        if (res.ok) {
          const data = await res.json();
          setLeads(data.leads ?? []);
          setHasMore(Boolean(data.hasMore));
          setResultCount(data.leads?.length ?? 0);
        }
      } catch (e) {
        console.error("Failed to fetch leads", e);
      } finally {
        setIsLoading(false);
      }
    },
    [bbox, tradeFilter, statusFilter, interactionFilter, buildingTypeFilter, projectKindFilter, developmentTypeFilter, stageFilter, relevanceFilter],
  );

  // Auto-fetch whenever any filter or the (debounced) bbox changes.
  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  useEffect(() => {
    return () => {
      if (bboxDebounceRef.current) clearTimeout(bboxDebounceRef.current);
    };
  }, []);

  const handleManualSearch = useCallback(
    (liveBbox: string | null) => {
      // Cancel any pending debounce so we don't double-fetch.
      if (bboxDebounceRef.current) {
        clearTimeout(bboxDebounceRef.current);
        bboxDebounceRef.current = null;
      }
      if (liveBbox && liveBbox !== bbox) {
        // Updating bbox triggers the auto-fetch via useEffect.
        setBbox(liveBbox);
      } else {
        // bbox unchanged (or no map ref) — force a refetch.
        fetchLeads(liveBbox ?? undefined);
      }
    },
    [bbox, fetchLeads],
  );

  const handleUpdateInteraction = async (
    leadId: string,
    status: InteractionStatus,
    notes: string,
  ) => {
    try {
      const res = await fetch("/api/leads/interact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, status, notes }),
      });

      if (res.ok) {
        setLeads((prev) =>
          prev.map((l) =>
            l.id === leadId ? { ...l, interaction: { status, notes } } : l,
          ),
        );
        if (selectedLead?.id === leadId) {
          setSelectedLead({ ...selectedLead, interaction: { status, notes } });
        }
      }
    } catch (e) {
      console.error("Failed to update interaction", e);
    }
  };

  // Picks a marker glyph by priority: relevance first, then development /
  // project kind. The glyph + interaction color together communicate type AND
  // status at a glance.
  const pickMarkerIcon = (lead: LeadWithInteraction): typeof Home => {
    const pk = lead.projectKind ?? "";
    const dt = lead.developmentType ?? "";
    if (pk === "Demolition") return Trash2;
    if (pk === "New Construction") {
      if (dt === "Multifamily" || dt === "Condo" || dt === "Townhouse") return Building2;
      return Home;
    }
    if (dt === "Multifamily" || dt === "Condo") return Building2;
    if (lead.aiRelevance === "high") return Flame;
    if (pk === "Remodel/Addition") return Wrench;
    return Sparkles;
  };

  const getPinColor = (interactionStatus?: InteractionStatus) => {
    switch (interactionStatus) {
      case InteractionStatus.CONTACTED:
        return "#10b981";
      case InteractionStatus.VISITED:
        return "#3b82f6";
      case InteractionStatus.NOT_INTERESTED:
        return "#64748b";
      case InteractionStatus.BIDDING:
        return "#f59e0b";
      default:
        return "#ef4444";
    }
  };

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] bg-slate-950 flex flex-col">
      <APIProvider apiKey={apiKey}>
        <MapControls
          filters={{
            trade: tradeFilter,
            status: statusFilter,
            interactionStatus: interactionFilter,
            buildingType: buildingTypeFilter,
            projectKind: projectKindFilter,
            developmentType: developmentTypeFilter,
            stage: stageFilter,
            relevance: relevanceFilter,
          }}
          setTradeFilter={setTradeFilter}
          setStatusFilter={setStatusFilter}
          setInteractionFilter={setInteractionFilter}
          setBuildingTypeFilter={setBuildingTypeFilter}
          setProjectKindFilter={setProjectKindFilter}
          setDevelopmentTypeFilter={setDevelopmentTypeFilter}
          setStageFilter={setStageFilter}
          setRelevanceFilter={setRelevanceFilter}
          applyPreset={(p) => {
            // Reset all to default, then apply the preset's patch atomically.
            setTradeFilter(p.patch.trade ?? "All");
            setStatusFilter(p.patch.status ?? "All");
            setInteractionFilter(p.patch.interactionStatus ?? "All");
            setBuildingTypeFilter(p.patch.buildingType ?? "All");
            setProjectKindFilter(p.patch.projectKind ?? "All");
            setDevelopmentTypeFilter(p.patch.developmentType ?? "All");
            setStageFilter(p.patch.stage ?? DEFAULT_FILTERS.stage);
            setRelevanceFilter(p.patch.relevance ?? "All");
          }}
          clearAll={() => {
            setTradeFilter("All");
            setStatusFilter("All");
            setInteractionFilter("All");
            setBuildingTypeFilter("All");
            setProjectKindFilter("All");
            setDevelopmentTypeFilter("All");
            setStageFilter(DEFAULT_FILTERS.stage);
            setRelevanceFilter("All");
          }}
          onSearch={handleManualSearch}
          isLoading={isLoading}
        />

        {/* Result indicator (top-right) */}
        <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
          {resultCount !== null && (
            <div className="bg-slate-900/90 backdrop-blur-md border border-slate-800 text-slate-300 text-xs px-3 py-2 rounded-lg shadow-xl">
              {isLoading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Searching…
                </span>
              ) : (
                <span>
                  <span className="text-white font-semibold">{resultCount}</span>{" "}
                  {resultCount === 1 ? "lead" : "leads"} in view
                </span>
              )}
            </div>
          )}
          {hasMore && (
            <div className="bg-amber-500/10 border border-amber-500/40 text-amber-300 text-xs px-3 py-2 rounded-lg backdrop-blur-md max-w-[260px]">
              Showing 500 best — zoom in to see more.
            </div>
          )}
        </div>

        <Map
          defaultCenter={{ lat: 47.6062, lng: -122.3321 }}
          defaultZoom={11}
          mapId="DEMO_MAP_ID"
          disableDefaultUI={true}
          onBoundsChanged={(e) => {
            const bounds = e.map.getBounds();
            if (!bounds) return;
            const ne = bounds.getNorthEast();
            const sw = bounds.getSouthWest();
            const next = `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`;
            if (bboxDebounceRef.current) clearTimeout(bboxDebounceRef.current);
            bboxDebounceRef.current = setTimeout(() => setBbox(next), BBOX_DEBOUNCE_MS);
          }}
        >
          {leads.map((lead) => {
            const color = getPinColor(lead.interaction?.status);
            const Icon = pickMarkerIcon(lead);
            const isHot = lead.aiRelevance === "high";
            return (
              <AdvancedMarker
                key={lead.id}
                position={{ lat: lead.latitude, lng: lead.longitude }}
                onClick={() => setSelectedLead(lead)}
              >
                <div
                  className="relative cursor-pointer"
                  onMouseEnter={() => setHoveredLead(lead)}
                  onMouseLeave={() => setHoveredLead((h) => (h?.id === lead.id ? null : h))}
                >
                  <div
                    className={`w-9 h-9 rounded-full border-2 border-white shadow-lg flex items-center justify-center transition-transform hover:scale-110 ${
                      isHot ? "ring-2 ring-orange-400/70" : ""
                    }`}
                    style={{ backgroundColor: color }}
                  >
                    <Icon size={16} className="text-white" strokeWidth={2.5} />
                  </div>
                  {isHot && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-orange-500 ring-2 ring-white animate-pulse"
                      aria-hidden
                    />
                  )}
                </div>
              </AdvancedMarker>
            );
          })}
          {hoveredLead && hoveredLead.id !== selectedLead?.id && (
            <InfoWindow
              position={{ lat: hoveredLead.latitude, lng: hoveredLead.longitude }}
              pixelOffset={[0, -28]}
              disableAutoPan
              headerDisabled
            >
              <div className="text-slate-900 max-w-[280px] -m-1">
                <div className="font-semibold text-sm leading-tight mb-1">
                  {hoveredLead.address}
                </div>
                <div className="flex flex-wrap gap-1 mb-1">
                  {hoveredLead.developmentType && (
                    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-800 font-medium">
                      {hoveredLead.developmentType}
                      {hoveredLead.housingUnits != null && hoveredLead.housingUnits > 0 &&
                        ` · ${hoveredLead.housingUnits}u`}
                    </span>
                  )}
                  {hoveredLead.projectKind && hoveredLead.projectKind !== "Other" && (
                    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 font-medium">
                      {hoveredLead.projectKind}
                    </span>
                  )}
                  {hoveredLead.aiRelevance === "high" && (
                    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 font-medium">
                      🔥 Hot
                    </span>
                  )}
                </div>
                {hoveredLead.aiSummary && (
                  <div className="text-[11px] text-slate-700 leading-snug mb-1">
                    {hoveredLead.aiSummary}
                  </div>
                )}
                <div className="text-[10px] text-slate-500">
                  {hoveredLead.sourceCity}
                  {hoveredLead.issuedDate && ` · issued ${new Date(hoveredLead.issuedDate).toLocaleDateString()}`}
                  {hoveredLead.projectValue ? ` · $${hoveredLead.projectValue.toLocaleString()}` : ""}
                </div>
              </div>
            </InfoWindow>
          )}
        </Map>
      </APIProvider>

      {selectedLead && (
        <LeadDetailsPanel
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdateInteraction={handleUpdateInteraction}
        />
      )}
    </div>
  );
}
