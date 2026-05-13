"use client";

import { useEffect, useState, useCallback } from "react";
import { APIProvider, Map, AdvancedMarker, Pin } from "@vis.gl/react-google-maps";
import { InteractionStatus } from "@prisma/client";
import LeadDetailsPanel, { LeadWithInteraction } from "./LeadDetailsPanel";

const MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "dummy_key_please_replace";

export default function LeadsMap() {
  const [leads, setLeads] = useState<LeadWithInteraction[]>([]);
  const [selectedLead, setSelectedLead] = useState<LeadWithInteraction | null>(null);
  const [bbox, setBbox] = useState<string>("");
  const [tradeFilter, setTradeFilter] = useState("All");

  const fetchLeads = useCallback(async () => {
    try {
      const url = new URL("/api/leads", window.location.origin);
      if (bbox) url.searchParams.set("bbox", bbox);
      if (tradeFilter !== "All") url.searchParams.set("trade", tradeFilter);

      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        setLeads(data);
      }
    } catch (e) {
      console.error("Failed to fetch leads", e);
    }
  }, [bbox, tradeFilter]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const handleUpdateInteraction = async (leadId: string, status: InteractionStatus, notes: string) => {
    try {
      const res = await fetch("/api/leads/interact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, status, notes }),
      });

      if (res.ok) {
        // Optimistically update local state
        setLeads((prev) =>
          prev.map((l) =>
            l.id === leadId
              ? { ...l, interaction: { status, notes } }
              : l
          )
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
      case InteractionStatus.CONTACTED: return "#10b981"; // Emerald
      case InteractionStatus.VISITED: return "#3b82f6"; // Blue
      case InteractionStatus.NOT_INTERESTED: return "#64748b"; // Slate
      case InteractionStatus.BIDDING: return "#f59e0b"; // Amber
      default: return "#ef4444"; // Red (Unread)
    }
  };

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] bg-slate-950 flex flex-col">
      {/* Top Filter Bar */}
      <div className="absolute top-4 left-4 z-10 bg-slate-900/90 backdrop-blur-md p-3 rounded-xl border border-slate-800 shadow-xl flex gap-3">
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
        <button 
          onClick={fetchLeads}
          className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition"
        >
          Search This Area
        </button>
      </div>

      {/* Map */}
      <APIProvider apiKey={MAPS_API_KEY}>
        <Map
          defaultCenter={{ lat: 47.6062, lng: -122.3321 }} // Default: Seattle
          defaultZoom={11}
          mapId="DEMO_MAP_ID" // Required for AdvancedMarker
          disableDefaultUI={true}
          onBoundsChanged={(e) => {
            const bounds = e.map.getBounds();
            if (bounds) {
              const ne = bounds.getNorthEast();
              const sw = bounds.getSouthWest();
              // west, south, east, north
              setBbox(`${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`);
            }
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

      {/* Details Panel */}
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
