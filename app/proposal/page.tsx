"use client";

import { useEffect, useState } from "react";
import { blankProposal, type Proposal } from "@/lib/proposal-mock";
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

export default function ProposalPage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}

function Inner() {
  const profile = useProfile();
  const [proposal, setProposal] = useState<Proposal>(blankProposal);
  const [preview, setPreview] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

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
            <AerialSection proposal={proposal} />
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
