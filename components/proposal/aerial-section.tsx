"use client";

import { useMemo } from "react";
import { Pencil, Sparkles } from "lucide-react";
import { lineLengthFt } from "@/components/estimate/aerial-canvas";
import { AerialReadonly } from "@/components/estimate/aerial-shared";
import { PresentationCanvas } from "./presentation-canvas";
import { GutterSystemBreakdown } from "./gutter-system-breakdown";
import { sampleEaves, sampleDownspouts } from "@/lib/mock-estimate";
import type { Downspout, EditableLine } from "@/lib/types";
import type { Proposal } from "@/lib/proposal-mock";
import { SectionHeader } from "./packages-section";

export function AerialSection({
  proposal,
  onChange,
  readOnly,
}: {
  proposal: Proposal;
  /** Provided when the contractor is in builder mode and we want
   *  edits to the eaves/downspouts to flow back into the proposal so
   *  totals + line items recompute. Omit for client-portal preview. */
  onChange?: (p: Proposal) => void;
  readOnly?: boolean;
}) {
  const takeoff = proposal.takeoff;
  const hasRealTakeoff = !!takeoff && takeoff.eaves.length > 0;
  const editable = !readOnly && !!onChange && hasRealTakeoff;

  // Recompute total LF from the live edited eaves so the badge stays in
  // sync as the contractor adjusts the trace. NaN-guard each line:
  // a single eave with bad coords (stale analysis predating the
  // projection NaN-safety pass) used to poison the entire sum and
  // produce "NaN LF" in the overlay. Treat bad lines as 0 — the
  // contractor edits them away rather than seeing junk.
  const safeLineLengthFt = (l: EditableLine): number => {
    // Use the satellite trace's own px-per-ft (carried in the takeoff) so
    // editing eaves here re-prices on the same scale the estimate used,
    // not the plan-mode 2.4. Undefined → lineLengthFt falls back to it.
    const v = lineLengthFt(l, takeoff?.canvasPxPerFt);
    return Number.isFinite(v) ? v : 0;
  };
  const liveEaveLF = useMemo(() => {
    if (!takeoff) return proposal.measurements.eaveLF;
    // When ALL eaves got dropped (every gutter_run had bad coords —
    // happens on stored analyses with malformed geometry), the live
    // sum is 0 and the contractor sees a misleading "0 LF" overlay
    // even though measurements.eaveLF is the real number. Fall back
    // to the stored value when nothing summable survived.
    const computed = takeoff.eaves.reduce(
      (acc, l) => acc + safeLineLengthFt(l),
      0,
    );
    return computed > 0
      ? Math.round(computed)
      : proposal.measurements.eaveLF;
  }, [takeoff, proposal.measurements.eaveLF]);

  // Wire canvas edits back into proposal state so /proposal's pricing
  // recomputes off the contractor's tweaks. measurements.eaveLF gets
  // updated so packageTotal() + buildLineItems pick up the new number.
  const handleEavesChange = (next: EditableLine[]) => {
    if (!onChange || !takeoff) return;
    const updatedLF = Math.round(
      next.reduce((acc, l) => acc + safeLineLengthFt(l), 0),
    );
    onChange({
      ...proposal,
      takeoff: { ...takeoff, eaves: next },
      measurements: {
        ...proposal.measurements,
        eaveLF: updatedLF,
      },
    });
  };

  const handleDownspoutsChange = (next: Downspout[]) => {
    if (!onChange || !takeoff) return;
    onChange({
      ...proposal,
      takeoff: { ...takeoff, downspouts: next },
      measurements: {
        ...proposal.measurements,
        downspoutCount: next.length,
      },
    });
  };

  return (
    <section data-section="aerial" className="space-y-4">
      <SectionHeader
        title="What we measured"
        sub={
          hasRealTakeoff
            ? editable
              ? "Live takeoff from the satellite image. Drag any handle to refine — totals update instantly."
              : "Eaves and downspouts traced directly from this property's satellite image."
            : "Sample geometry — connect this proposal to a takeoff to render the real roof."
        }
      />
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-2xl">
          {hasRealTakeoff ? (
            <div className="aspect-[16/10]">
              <PresentationCanvas
                eaves={takeoff!.eaves}
                rakes={takeoff!.rakes}
                downspouts={takeoff!.downspouts}
                roofStructure={takeoff!.roofStructure}
                onEavesChange={editable ? handleEavesChange : undefined}
                onDownspoutsChange={editable ? handleDownspoutsChange : undefined}
                pxPerFt={takeoff!.canvasPxPerFt}
                aerialImageUrl={takeoff!.aerial?.imageDataUrl}
                // Plan-based takeoffs have no satellite image. Switch
                // the canvas into drafting-paper mode so the gutter
                // trace reads as an architectural drawing instead of
                // being painted on top of the cartoon yard scene.
                planMode={!takeoff!.aerial?.imageDataUrl}
              />
            </div>
          ) : (
            <AerialReadonly
              eaves={sampleEaves}
              downspouts={sampleDownspouts}
              className="aspect-[16/10]"
              theme="tactical"
            />
          )}
          {hasRealTakeoff && (
            <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-medium text-emerald-200 ring-1 ring-inset ring-emerald-500/40 backdrop-blur">
              <Sparkles className="h-3 w-3" />
              Live from AI takeoff
            </div>
          )}
          {editable && (
            <div className="pointer-events-none absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-slate-900/80 px-2.5 py-1 text-[10px] font-medium text-cyan-100/85 ring-1 ring-inset ring-cyan-400/30 backdrop-blur">
              <Pencil className="h-3 w-3" />
              Hover an eave to drag a corner — totals re-price live
            </div>
          )}
        </div>
        {hasRealTakeoff && (
          <GutterSystemBreakdown
            eaves={takeoff!.eaves}
            rakes={takeoff!.rakes}
            downspouts={takeoff!.downspouts}
            pxPerFt={takeoff!.canvasPxPerFt}
            measurements={{
              ...proposal.measurements,
              eaveLF: liveEaveLF,
            }}
            // Default-feature package (e.g. "Pro Shield") since the
            // proposal model doesn't yet store a selectedPackageId.
            selectedPackageName={proposal.packages[1]?.name}
          />
        )}
      </div>
    </section>
  );
}
