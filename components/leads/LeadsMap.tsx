"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  APIProvider,
  Map as GoogleMap,
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
  MapPin,
  Activity,
} from "lucide-react";
import LeadDetailsPanel, { LeadWithInteraction } from "./LeadDetailsPanel";
import LeadsSidebar, {
  type LeadsSidebarHandle,
  type SortMode,
} from "./LeadsSidebar";

/* ------------------------------------------------------------------ */
/*   Grid-based marker clustering                                     */
/*                                                                    */
/*   Bin leads into a lat/lng grid whose cell size scales with the    */
/*   current map zoom. Cells holding >=3 leads render as a single     */
/*   cluster badge; cells with <3 render as individual markers.       */
/*                                                                    */
/*   Above zoom 14, clustering disengages entirely (the user has      */
/*   zoomed in far enough that overlap isn't an issue).               */
/* ------------------------------------------------------------------ */
type Cluster = {
  id: string;
  lat: number;
  lng: number;
  count: number;
  hotCount: number;
};

/**
 * Translate a project value into a marker diameter (in px) on a log
 * scale. Projects span ~$5K → $5M+, so a linear scale would render
 * every residential permit the same and the big multifamily / new-build
 * projects wouldn't pop. log10($5K)≈3.7, log10($5M)≈6.7 — we map that
 * 3-decade range onto 28–52 px. Anything off the bottom (no value
 * reported) renders at the minimum so it's still visible.
 */
function markerSizePx(value: number | null | undefined): number {
  if (!value || value <= 0) return 28;
  const v = Math.log10(value);
  const norm = Math.max(0, Math.min(1, (v - 3.7) / 3));
  return Math.round(28 + norm * 24);
}

function clusterLeads(
  leads: LeadWithInteraction[],
  zoom: number,
): { clusters: Cluster[]; unclustered: LeadWithInteraction[] } {
  if (zoom >= 14) return { clusters: [], unclustered: leads };
  // Cell size halves with each zoom level — mirrors how a single
  // screen-pixel maps to fewer real-world degrees as you zoom in. The
  // 0.06 base was tuned empirically against Seattle-area density.
  const gridDeg = 0.06 / Math.pow(2, Math.max(0, zoom - 10));
  const buckets = new Map<string, LeadWithInteraction[]>();
  for (const lead of leads) {
    const bx = Math.floor(lead.longitude / gridDeg);
    const by = Math.floor(lead.latitude / gridDeg);
    const key = `${bx},${by}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(lead);
  }
  const clusters: Cluster[] = [];
  const unclustered: LeadWithInteraction[] = [];
  for (const [key, arr] of buckets.entries()) {
    if (arr.length >= 3) {
      let sumLat = 0;
      let sumLng = 0;
      let hot = 0;
      for (const l of arr) {
        sumLat += l.latitude;
        sumLng += l.longitude;
        if (l.aiRelevance === "high") hot++;
      }
      clusters.push({
        id: `c-${key}`,
        lat: sumLat / arr.length,
        lng: sumLng / arr.length,
        count: arr.length,
        hotCount: hot,
      });
    } else {
      for (const l of arr) unclustered.push(l);
    }
  }
  return { clusters, unclustered };
}

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
  const [zoom, setZoom] = useState(11);
  const [sort, setSort] = useState<SortMode>("relevance");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<"pins" | "heatmap">("pins");
  // Visible diagnostic when the fetch fails. Without this the map just
  // looks empty and the user has no way to tell whether (a) no leads
  // match the filter, (b) the API errored, or (c) the session expired
  // and the request got redirected to /sign-in.
  const [fetchError, setFetchError] = useState<string | null>(null);
  const bboxDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarRef = useRef<LeadsSidebarHandle>(null);

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

        const res = await fetch(url.toString(), { redirect: "manual" });
        // Redirect-to-sign-in (Clerk middleware) lands here when the
        // session expires mid-session. fetch with redirect:"manual"
        // surfaces this as an opaque response with type "opaqueredirect"
        // rather than silently following to an HTML page.
        if (res.type === "opaqueredirect" || res.status === 0) {
          setFetchError(
            "Session expired — refresh the page to sign back in.",
          );
          setLeads([]);
          setResultCount(0);
          return;
        }
        if (!res.ok) {
          // Pull the server-side error message + Prisma metadata out of
          // the JSON body. P2022 (column missing) puts the column name
          // at meta.column; P2021 puts the table at meta.table. Render
          // whichever is present so the toast is actually actionable.
          let detail = "";
          try {
            const body = (await res.json()) as {
              error?: string;
              code?: string;
              meta?: { column?: string; table?: string };
            };
            if (body?.error) detail = ` — ${body.error}`;
            if (body?.code) detail += ` [${body.code}]`;
            if (body?.meta?.column) detail += ` (column: ${body.meta.column})`;
            if (body?.meta?.table) detail += ` (table: ${body.meta.table})`;
          } catch {
            // not JSON
          }
          setFetchError(
            `Lead fetch failed (HTTP ${res.status})${detail}`,
          );
          setLeads([]);
          setResultCount(0);
          return;
        }
        const data = await res.json();
        setFetchError(null);
        setLeads(data.leads ?? []);
        setHasMore(Boolean(data.hasMore));
        setResultCount(data.leads?.length ?? 0);
      } catch (e) {
        console.error("Failed to fetch leads", e);
        setFetchError(
          e instanceof Error
            ? `Network error: ${e.message}`
            : "Network error fetching leads.",
        );
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

  // Sorted view for the sidebar. The map always renders all leads; the
  // sidebar shows them in the contractor's chosen priority order.
  const sortedLeads = useMemo(() => {
    const arr = [...leads];
    const relRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    if (sort === "relevance") {
      arr.sort((a, b) => {
        const ra = relRank[a.aiRelevance ?? ""] ?? 3;
        const rb = relRank[b.aiRelevance ?? ""] ?? 3;
        if (ra !== rb) return ra - rb;
        // Tiebreaker: newer issued date first.
        const da = a.issuedDate ? new Date(a.issuedDate).getTime() : 0;
        const db = b.issuedDate ? new Date(b.issuedDate).getTime() : 0;
        return db - da;
      });
    } else if (sort === "newest") {
      arr.sort((a, b) => {
        const da = a.issuedDate ? new Date(a.issuedDate).getTime() : 0;
        const db = b.issuedDate ? new Date(b.issuedDate).getTime() : 0;
        return db - da;
      });
    } else {
      // "value"
      arr.sort((a, b) => (b.projectValue ?? 0) - (a.projectValue ?? 0));
    }
    return arr;
  }, [leads, sort]);

  // Cluster at the current zoom. Memo so we only recompute when leads or
  // zoom actually change — onBoundsChanged fires constantly during pan.
  const { clusters, unclustered } = useMemo(
    () => clusterLeads(leads, zoom),
    [leads, zoom],
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full bg-slate-950">
      <APIProvider apiKey={apiKey} libraries={["visualization"]}>
        <LeadsSidebar
          ref={sidebarRef}
          leads={sortedLeads}
          hoveredLeadId={hoveredLead?.id ?? null}
          selectedLeadId={selectedLead?.id ?? null}
          onHover={setHoveredLead}
          onSelect={setSelectedLead}
          isLoading={isLoading}
          hasMore={hasMore}
          sort={sort}
          onSortChange={setSort}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        />

        <div className="relative flex-1">
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

          {/* Result indicator + view-mode toggle (top-right of map) */}
          <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
            <div className="pointer-events-auto inline-flex rounded-xl border border-slate-800 bg-slate-900/90 p-1 shadow-xl backdrop-blur-md">
              <button
                onClick={() => setViewMode("pins")}
                title="Show individual leads"
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                  viewMode === "pins"
                    ? "bg-emerald-500/15 text-emerald-200 ring-1 ring-inset ring-emerald-500/40"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <MapPin size={12} />
                Pins
              </button>
              <button
                onClick={() => setViewMode("heatmap")}
                title="Show density heatmap (weighted by project value)"
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                  viewMode === "heatmap"
                    ? "bg-orange-500/15 text-orange-200 ring-1 ring-inset ring-orange-500/40"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <Activity size={12} />
                Heatmap
              </button>
            </div>
            {resultCount !== null && isLoading && (
              <div className="pointer-events-none rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-2 text-xs text-slate-300 shadow-xl backdrop-blur-md">
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Searching…
                </span>
              </div>
            )}
            {hasMore && (
              <div className="pointer-events-none max-w-[260px] rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 backdrop-blur-md">
                Showing 500 best — zoom in to see more.
              </div>
            )}
            {fetchError && (
              <div className="pointer-events-none max-w-[320px] rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 backdrop-blur-md">
                {fetchError}
              </div>
            )}
          </div>

          {/* Center overlay when the fetch succeeded but returned no leads
              — gives the user something to act on (pan the map / widen
              the filters) instead of staring at an empty satellite tile. */}
          {!isLoading &&
            !fetchError &&
            resultCount === 0 &&
            leads.length === 0 && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
                <div className="pointer-events-auto max-w-sm rounded-2xl border border-slate-700 bg-slate-900/95 px-5 py-4 text-center shadow-2xl backdrop-blur">
                  <Inbox className="mx-auto h-7 w-7 text-slate-500" />
                  <div className="mt-2 text-sm font-medium text-white">
                    No leads in this view
                  </div>
                  <p className="mt-1 text-xs leading-snug text-slate-400">
                    Pan or zoom to a different area, or clear active
                    filters (e.g. preset chips, date range) to widen the
                    search.
                  </p>
                </div>
              </div>
            )}

          <GoogleMap
            defaultCenter={{ lat: 47.6062, lng: -122.3321 }}
            defaultZoom={11}
            mapId="DEMO_MAP_ID"
            disableDefaultUI={true}
            onBoundsChanged={(e) => {
              const bounds = e.map.getBounds();
              if (!bounds) return;
              const z = e.map.getZoom();
              if (typeof z === "number") setZoom(z);
              const ne = bounds.getNorthEast();
              const sw = bounds.getSouthWest();
              const next = `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`;
              if (bboxDebounceRef.current) clearTimeout(bboxDebounceRef.current);
              bboxDebounceRef.current = setTimeout(
                () => setBbox(next),
                BBOX_DEBOUNCE_MS,
              );
            }}
          >
            {/* Pans to selected lead — only when selection ID changes */}
            <MapPanner target={selectedLead} />

            {viewMode === "heatmap" && <HeatmapLayer leads={leads} />}

            {/* Cluster badges (zoom < 14) */}
            {viewMode === "pins" &&
              clusters.map((c) => <ClusterMarker key={c.id} cluster={c} />)}

            {/* Individual markers */}
            {viewMode === "pins" &&
              unclustered.map((lead) => {
              const color = getPinColor(lead.interaction?.status);
              const Icon = pickMarkerIcon(lead);
              const isHot = lead.aiRelevance === "high";
              const isHovered = hoveredLead?.id === lead.id;
              const isSelected = selectedLead?.id === lead.id;
              // Value-driven base size; hover / select bump it slightly
              // for visual feedback without overriding the value cue.
              const baseSize = markerSizePx(lead.projectValue);
              const size = isSelected
                ? baseSize + 8
                : isHovered
                  ? baseSize + 4
                  : baseSize;
              const iconSize = Math.round(size * 0.45);
              return (
                <AdvancedMarker
                  key={lead.id}
                  position={{ lat: lead.latitude, lng: lead.longitude }}
                  onClick={() => setSelectedLead(lead)}
                  zIndex={isSelected ? 1000 : isHovered ? 500 : isHot ? 100 : 1}
                >
                  <div
                    className="relative cursor-pointer"
                    onMouseEnter={() => setHoveredLead(lead)}
                    onMouseLeave={() =>
                      setHoveredLead((h) => (h?.id === lead.id ? null : h))
                    }
                  >
                    <div
                      className={`flex items-center justify-center rounded-full border-2 border-white shadow-lg transition-all ${
                        isSelected
                          ? "ring-4 ring-emerald-400/70"
                          : isHovered
                            ? "ring-4 ring-cyan-400/60"
                            : isHot
                              ? "ring-2 ring-orange-400/70"
                              : ""
                      }`}
                      style={{
                        backgroundColor: color,
                        width: size,
                        height: size,
                      }}
                    >
                      <Icon
                        size={iconSize}
                        className="text-white"
                        strokeWidth={2.5}
                      />
                    </div>
                    {isHot && !isSelected && (
                      <span
                        className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-orange-500 ring-2 ring-white animate-pulse"
                        aria-hidden
                      />
                    )}
                  </div>
                </AdvancedMarker>
              );
            })}

            {/* Hover preview (only when a marker is hovered AND it's
                visible as an individual pin — clusters don't get a
                preview because they represent many leads). */}
            {hoveredLead &&
              hoveredLead.id !== selectedLead?.id &&
              unclustered.some((l) => l.id === hoveredLead.id) && (
                <InfoWindow
                  position={{
                    lat: hoveredLead.latitude,
                    lng: hoveredLead.longitude,
                  }}
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
                          {hoveredLead.housingUnits != null &&
                            hoveredLead.housingUnits > 0 &&
                            ` · ${hoveredLead.housingUnits}u`}
                        </span>
                      )}
                      {hoveredLead.projectKind &&
                        hoveredLead.projectKind !== "Other" && (
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
                      {hoveredLead.issuedDate &&
                        ` · issued ${new Date(
                          hoveredLead.issuedDate,
                        ).toLocaleDateString()}`}
                      {hoveredLead.projectValue
                        ? ` · $${hoveredLead.projectValue.toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                </InfoWindow>
              )}
          </GoogleMap>
        </div>
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

/* ------------------------------------------------------------------ */
/*   MapPanner — pans the map to a target lead whenever its ID changes */
/* ------------------------------------------------------------------ */
function MapPanner({ target }: { target: LeadWithInteraction | null }) {
  const map = useMap();
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!map || !target) {
      lastIdRef.current = target?.id ?? null;
      return;
    }
    if (lastIdRef.current === target.id) return;
    lastIdRef.current = target.id;
    map.panTo({ lat: target.latitude, lng: target.longitude });
  }, [map, target]);
  return null;
}

/* ------------------------------------------------------------------ */
/*   ClusterMarker — circular count badge; click zooms in + pans      */
/* ------------------------------------------------------------------ */
function ClusterMarker({ cluster }: { cluster: Cluster }) {
  const map = useMap();
  // Visual size scales mildly with count so a 50-lead cluster reads as
  // bigger than a 5-lead one without dominating the map.
  const size = Math.min(64, 36 + Math.log2(cluster.count) * 6);
  const fontSize = cluster.count >= 100 ? 13 : cluster.count >= 10 ? 14 : 16;
  const hot = cluster.hotCount > 0;
  return (
    <AdvancedMarker
      position={{ lat: cluster.lat, lng: cluster.lng }}
      onClick={() => {
        if (!map) return;
        const z = map.getZoom() ?? 11;
        map.panTo({ lat: cluster.lat, lng: cluster.lng });
        // Zoom in by 2 — usually breaks the cluster apart enough to see
        // its constituents but doesn't fly past street-level detail.
        map.setZoom(Math.min(z + 2, 18));
      }}
      zIndex={50}
    >
      <div
        className="relative flex cursor-pointer items-center justify-center rounded-full text-white font-bold shadow-xl ring-4 ring-white/80 transition hover:scale-110"
        style={{
          width: size,
          height: size,
          fontSize,
          background: hot
            ? "radial-gradient(circle at 30% 30%, #fb923c, #ea580c 70%)"
            : "radial-gradient(circle at 30% 30%, #34d399, #059669 70%)",
        }}
        title={`${cluster.count} leads — click to zoom in`}
      >
        {cluster.count}
        {hot && (
          <span className="absolute -top-1 -right-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-orange-500 text-[8px] font-bold ring-2 ring-white">
            {cluster.hotCount > 9 ? "9+" : cluster.hotCount}
          </span>
        )}
      </div>
    </AdvancedMarker>
  );
}

/* ------------------------------------------------------------------ */
/*   HeatmapLayer — density view weighted by project value            */
/*                                                                    */
/*   The Google Maps visualization library has no first-class React   */
/*   wrapper in @vis.gl/react-google-maps, so we drive it imperatively:*/
/*   construct google.maps.visualization.HeatmapLayer, attach it via  */
/*   setMap, and tear down on unmount or input change.                */
/* ------------------------------------------------------------------ */
function HeatmapLayer({ leads }: { leads: LeadWithInteraction[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    // The visualization library is loaded via APIProvider's `libraries`
    // prop; on first mount it may not have finished injecting yet so
    // guard accordingly. Re-runs of this effect will pick it up.
    const g = typeof window !== "undefined"
      ? (window as unknown as { google?: typeof google }).google
      : undefined;
    const viz = g?.maps?.visualization;
    if (!viz) return;

    // Weight each point by log(value). Same log scale used for marker
    // sizing — keeps the visual story consistent between modes. Leads
    // without a value get weight=1 so they still register on the map.
    const data = leads.map((lead) => {
      const v = lead.projectValue ?? 0;
      const weight = v > 0 ? Math.max(1, Math.log10(v)) : 1;
      return {
        location: new g!.maps.LatLng(lead.latitude, lead.longitude),
        weight,
      };
    });

    const layer = new viz.HeatmapLayer({
      data,
      map,
      // Empirically tuned: at default zoom the radius reads as
      // "neighborhood-sized" without bleeding into a single solid blob
      // over Bellevue.
      radius: 28,
      opacity: 0.75,
      // Default gradient is blue→red. We override to a green→amber→red
      // ramp so the heatmap visually echoes the sidebar's
      // Cold→Warm→Hot relevance vocabulary.
      gradient: [
        "rgba(16, 185, 129, 0)",
        "rgba(16, 185, 129, 0.65)",
        "rgba(132, 204, 22, 0.75)",
        "rgba(234, 179, 8, 0.85)",
        "rgba(249, 115, 22, 0.95)",
        "rgba(239, 68, 68, 1)",
      ],
    });

    return () => {
      layer.setMap(null);
    };
  }, [map, leads]);
  return null;
}
