"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { APIProvider, Map, AdvancedMarker, Pin, useMap } from "@vis.gl/react-google-maps";
import { InteractionStatus, LeadStatus } from "@prisma/client";
import { Loader2, Search } from "lucide-react";
import LeadDetailsPanel, { LeadWithInteraction } from "./LeadDetailsPanel";

const BBOX_DEBOUNCE_MS = 400;

interface MapControlsProps {
  tradeFilter: string;
  setTradeFilter: (v: string) => void;
  statusFilter: LeadStatus | "All";
  setStatusFilter: (v: LeadStatus | "All") => void;
  interactionFilter: InteractionStatus | "All";
  setInteractionFilter: (v: InteractionStatus | "All") => void;
  buildingTypeFilter: string;
  setBuildingTypeFilter: (v: string) => void;
  projectKindFilter: string;
  setProjectKindFilter: (v: string) => void;
  relevanceFilter: string;
  setRelevanceFilter: (v: string) => void;
  onSearch: (bbox: string | null) => void;
  isLoading: boolean;
}

function MapControls({
  tradeFilter,
  setTradeFilter,
  statusFilter,
  setStatusFilter,
  interactionFilter,
  setInteractionFilter,
  buildingTypeFilter,
  setBuildingTypeFilter,
  projectKindFilter,
  setProjectKindFilter,
  relevanceFilter,
  setRelevanceFilter,
  onSearch,
  isLoading,
}: MapControlsProps) {
  const map = useMap();

  const handleSearchClick = () => {
    if (!map) {
      onSearch(null);
      return;
    }
    const bounds = map.getBounds();
    if (!bounds) {
      onSearch(null);
      return;
    }
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    onSearch(`${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`);
  };

  return (
    <div className="absolute top-4 left-4 z-10 bg-slate-900/90 backdrop-blur-md p-3 rounded-xl border border-slate-800 shadow-xl flex flex-wrap gap-3">
      <select
        className="bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500"
        value={tradeFilter}
        onChange={(e) => setTradeFilter(e.target.value)}
      >
        <option value="All">All Trades</option>
        <option value="Roofing">Roofing</option>
        <option value="Gutters">Gutters</option>
        <option value="Framing">Framing</option>
        <option value="Siding">Siding</option>
        <option value="Windows">Windows</option>
      </select>

      <select
        className="bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "All")}
      >
        <option value="All">All Permit Statuses</option>
        <option value={LeadStatus.APPLIED}>Applied</option>
        <option value={LeadStatus.UNDER_REVIEW}>Under Review</option>
        <option value={LeadStatus.ISSUED}>Issued</option>
        <option value={LeadStatus.INSPECTION}>Inspection</option>
        <option value={LeadStatus.FINALED}>Finaled</option>
        <option value={LeadStatus.UNKNOWN}>Unknown</option>
      </select>

      <select
        className="bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500"
        value={interactionFilter}
        onChange={(e) => setInteractionFilter(e.target.value as InteractionStatus | "All")}
      >
        <option value="All">All My Statuses</option>
        <option value={InteractionStatus.UNREAD}>Unread</option>
        <option value={InteractionStatus.CONTACTED}>Contacted</option>
        <option value={InteractionStatus.VISITED}>Visited</option>
        <option value={InteractionStatus.BIDDING}>Bidding</option>
        <option value={InteractionStatus.NOT_INTERESTED}>Not Interested</option>
      </select>

      <select
        className="bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500"
        value={buildingTypeFilter}
        onChange={(e) => setBuildingTypeFilter(e.target.value)}
      >
        <option value="All">All Building Types</option>
        <option value="Residential">Residential (any)</option>
        <option value="Single Family/Duplex">Single Family / Duplex</option>
        <option value="Multifamily">Multifamily</option>
        <option value="Commercial">Commercial</option>
        <option value="Institutional">Institutional</option>
        <option value="Industrial">Industrial</option>
      </select>

      <select
        className="bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500"
        value={projectKindFilter}
        onChange={(e) => setProjectKindFilter(e.target.value)}
      >
        <option value="All">All Project Types</option>
        <option value="New Construction">New Construction</option>
        <option value="Remodel/Addition">Remodel / Addition</option>
        <option value="Tenant Improvement">Tenant Improvement</option>
        <option value="Demolition">Demolition</option>
        <option value="Other">Other</option>
      </select>

      <select
        className="bg-slate-800 text-sm text-white rounded-lg px-3 py-2 border border-slate-700 outline-none focus:border-emerald-500"
        value={relevanceFilter}
        onChange={(e) => setRelevanceFilter(e.target.value)}
      >
        <option value="All">Any Relevance</option>
        <option value="high">🔥 Hot leads</option>
        <option value="medium">Warm leads</option>
        <option value="low">Cold leads</option>
      </select>

      <button
        onClick={handleSearchClick}
        disabled={isLoading}
        className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg font-medium transition inline-flex items-center gap-1.5"
      >
        {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        Search This Area
      </button>
    </div>
  );
}

export default function LeadsMap({ apiKey }: { apiKey: string }) {
  const [leads, setLeads] = useState<LeadWithInteraction[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithInteraction | null>(null);
  const [bbox, setBbox] = useState<string>("");
  const [tradeFilter, setTradeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "All">("All");
  const [interactionFilter, setInteractionFilter] = useState<InteractionStatus | "All">("All");
  const [buildingTypeFilter, setBuildingTypeFilter] = useState("All");
  const [projectKindFilter, setProjectKindFilter] = useState("All");
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
    [bbox, tradeFilter, statusFilter, interactionFilter, buildingTypeFilter, projectKindFilter, relevanceFilter],
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
          tradeFilter={tradeFilter}
          setTradeFilter={setTradeFilter}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          interactionFilter={interactionFilter}
          setInteractionFilter={setInteractionFilter}
          buildingTypeFilter={buildingTypeFilter}
          setBuildingTypeFilter={setBuildingTypeFilter}
          projectKindFilter={projectKindFilter}
          setProjectKindFilter={setProjectKindFilter}
          relevanceFilter={relevanceFilter}
          setRelevanceFilter={setRelevanceFilter}
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
              Showing 200 newest — zoom in to see more.
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
          {leads.map((lead) => (
            <AdvancedMarker
              key={lead.id}
              position={{ lat: lead.latitude, lng: lead.longitude }}
              onClick={() => setSelectedLead(lead)}
            >
              <Pin
                background={getPinColor(lead.interaction?.status)}
                borderColor="rgba(0,0,0,0.5)"
                glyphColor="#fff"
              />
            </AdvancedMarker>
          ))}
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
