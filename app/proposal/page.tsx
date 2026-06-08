"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { blankProposal, type Proposal } from "@/lib/proposal-mock";
import {
  clearEstimateHandoff,
  readEstimateHandoff,
} from "@/lib/estimate-handoff";
import { AuthGate } from "@/components/auth/auth-gate";
import { ProposalTopBar } from "@/components/proposal/proposal-top-bar";
import { CoverSection } from "@/components/proposal/cover-section";
import { AerialSection } from "@/components/proposal/aerial-section";
import { PackagesSection } from "@/components/proposal/packages-section";
import { PhotosSection } from "@/components/proposal/photos-section";
import { TermsSection } from "@/components/proposal/terms-section";
import { BuilderSidebar } from "@/components/proposal/builder-sidebar";
import { SendModal } from "@/components/proposal/send-modal";
import { ClientPortalView } from "@/components/client-portal/client-portal-view";
import { useProfile } from "@/lib/auth-mock";
import { getMyProposal } from "@/app/actions/dashboard";

export default function ProposalPage() {
  return (
    <AuthGate>
      <Suspense fallback={null}>
        <Inner />
      </Suspense>
    </AuthGate>
  );
}

function Inner() {
  const params = useSearchParams();
  const proposalId = params.get("id");
  const profile = useProfile();
  const [proposal, setProposal] = useState<Proposal>(blankProposal);
  const [preview, setPreview] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [handoffApplied, setHandoffApplied] = useState(false);

  // Two ways the editor gets seeded:
  //   1. ?id=<proposalId> → load the saved row from the DB so the
  //      contractor can edit / re-send an existing draft. Without this
  //      the editor was starting from blankProposal and the send modal
  //      rejected with "Property address is required".
  //   2. handoff in localStorage → fresh from the /estimate flow.
  // ?id wins when both are present so a re-opened draft never gets
  // overwritten by stale handoff data left behind in localStorage.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (proposalId) {
        const loaded = await getMyProposal(proposalId);
        if (cancelled) return;
        if (loaded) {
          setProposal(loaded);
          // Clear any stale handoff so it doesn't leak into the next
          // fresh /proposal load.
          clearEstimateHandoff();
          setHandoffApplied(true);
          return;
        }
      }
      const handoff = readEstimateHandoff();
      if (handoff) {
        setProposal((p) => ({
          ...p,
          address: handoff.address,
          measurements: handoff.measurements,
          takeoff: {
            eaves: handoff.eaves,
            rakes: handoff.rakes,
            downspouts: handoff.downspouts,
            aerial: handoff.aerial,
          },
        }));
        clearEstimateHandoff();
      }
      if (!cancelled) setHandoffApplied(true);
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  useEffect(() => {
    setProposal((p) => ({
      ...p,
      contractor: {
        ...p.contractor,
        company: profile.company,
        name: profile.contractorName,
        email: profile.email,
        phone: profile.phone,
        license: profile.license,
        stripePaymentUrl: profile.payments.stripeUrl,
        squarePaymentUrl: profile.payments.squareUrl,
      },
    }));
  }, [
    profile.company,
    profile.contractorName,
    profile.email,
    profile.phone,
    profile.license,
    profile.payments.stripeUrl,
    profile.payments.squareUrl,
  ]);

  // Avoid a one-frame flash of the sample numbers while we read
  // localStorage. handoffApplied flips true on the first mount effect.
  if (!handoffApplied) return null;

  function download() {
    if (typeof window !== "undefined") window.print();
  }

  return (
    <div className="min-h-screen">
      <ProposalTopBar
        address={proposal.address}
        preview={preview}
        onTogglePreview={() => setPreview((v) => !v)}
        onSend={() => setSendOpen(true)}
        onDownload={download}
      />

      {preview ? (
        <ClientPortalView proposal={proposal} previewMode />
      ) : (
        <main className="mx-auto grid max-w-[1600px] gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:p-6">
          <div className="space-y-6">
            <CoverSection proposal={proposal} onChange={setProposal} />
            <AerialSection proposal={proposal} onChange={setProposal} />
            <PackagesSection proposal={proposal} onChange={setProposal} />
            <PhotosSection proposal={proposal} onChange={setProposal} />
            <TermsSection proposal={proposal} onChange={setProposal} />
          </div>
          <div className="lg:sticky lg:top-[80px] lg:self-start">
            <BuilderSidebar
              proposal={proposal}
              onChange={setProposal}
              onSend={() => setSendOpen(true)}
            />
          </div>
        </main>
      )}

      <SendModal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        proposal={proposal}
      />
    </div>
  );
}
