"use client";

import { motion, AnimatePresence } from "framer-motion";
import { LeadStatus, InteractionStatus } from "@prisma/client";
import { useState } from "react";
import { X, MapPin, Tag, Building, Clock, ChevronRight } from "lucide-react";

export interface LeadWithInteraction {
  id: string;
  sourceCity: string;
  address: string;
  originalDescription: string;
  categorizedTrade: string | null;
  status: LeadStatus;
  latitude: number;
  longitude: number;
  projectValue: number | null;
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

export default function LeadDetailsPanel({ lead, onClose, onUpdateInteraction }: LeadDetailsPanelProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [notes, setNotes] = useState("");

  if (!lead) return null;

  const currentInteractionStatus = lead.interaction?.status || InteractionStatus.UNREAD;
  const currentNotes = lead.interaction?.notes || "";

  const handleStatusChange = async (status: InteractionStatus) => {
    setIsUpdating(true);
    await onUpdateInteraction(lead.id, status, notes || currentNotes);
    setIsUpdating(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 20, stiffness: 200 }}
        className="absolute top-0 right-0 w-96 h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col z-50 text-slate-200"
      >
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50 backdrop-blur-md">
          <h2 className="text-lg font-semibold text-white">Lead Details</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Header Info */}
          <div>
            <div className="flex items-center gap-2 text-emerald-400 mb-2">
              <Tag size={16} />
              <span className="font-semibold">{lead.categorizedTrade || "Uncategorized"}</span>
            </div>
            <h3 className="text-xl font-bold text-white mb-1">{lead.address}</h3>
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <MapPin size={14} />
              <span>{lead.sourceCity}</span>
            </div>
          </div>

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-800 p-3 rounded-lg">
              <div className="text-slate-400 text-xs flex items-center gap-1 mb-1">
                <Clock size={12} /> Status
              </div>
              <div className="font-medium text-white">{lead.status.replace("_", " ")}</div>
            </div>
            <div className="bg-slate-800 p-3 rounded-lg">
              <div className="text-slate-400 text-xs flex items-center gap-1 mb-1">
                <Building size={12} /> Est. Value
              </div>
              <div className="font-medium text-white">
                {lead.projectValue ? `$${(lead.projectValue).toLocaleString()}` : "N/A"}
              </div>
            </div>
          </div>

          {/* Description */}
          <div>
            <h4 className="text-sm font-semibold text-slate-300 mb-2">Permit Description</h4>
            <div className="bg-slate-800/50 p-3 rounded-lg text-sm text-slate-400 leading-relaxed">
              {lead.originalDescription}
            </div>
          </div>

          <hr className="border-slate-800" />

          {/* CRM Actions */}
          <div>
            <h4 className="text-sm font-semibold text-slate-300 mb-3">Your Action</h4>
            
            <div className="space-y-2">
              <button 
                onClick={() => handleStatusChange(InteractionStatus.CONTACTED)}
                disabled={isUpdating}
                className={`w-full py-2.5 px-4 rounded-lg font-medium transition flex items-center justify-between ${
                  currentInteractionStatus === InteractionStatus.CONTACTED 
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50" 
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                }`}
              >
                Mark as Contacted
                {currentInteractionStatus === InteractionStatus.CONTACTED && <ChevronRight size={16} />}
              </button>
              
              <button 
                onClick={() => handleStatusChange(InteractionStatus.VISITED)}
                disabled={isUpdating}
                className={`w-full py-2.5 px-4 rounded-lg font-medium transition flex items-center justify-between ${
                  currentInteractionStatus === InteractionStatus.VISITED 
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/50" 
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                }`}
              >
                Mark as Visited
                {currentInteractionStatus === InteractionStatus.VISITED && <ChevronRight size={16} />}
              </button>

              <button 
                onClick={() => handleStatusChange(InteractionStatus.NOT_INTERESTED)}
                disabled={isUpdating}
                className={`w-full py-2.5 px-4 rounded-lg font-medium transition flex items-center justify-between ${
                  currentInteractionStatus === InteractionStatus.NOT_INTERESTED 
                  ? "bg-red-500/20 text-red-400 border border-red-500/50" 
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                }`}
              >
                Not Interested
                {currentInteractionStatus === InteractionStatus.NOT_INTERESTED && <ChevronRight size={16} />}
              </button>
            </div>
          </div>

          {/* Notes */}
          <div>
            <h4 className="text-sm font-semibold text-slate-300 mb-2">Private Notes</h4>
            <textarea
              value={notes || currentNotes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add notes about this lead..."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              rows={4}
            />
            <button
              onClick={() => handleStatusChange(currentInteractionStatus)}
              className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 transition"
            >
              Save Notes
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
