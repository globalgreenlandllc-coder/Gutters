"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, Phone, Mail } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Badge } from "@/components/ui/badge";
import { AerialSection } from "@/components/proposal/aerial-section";
import { PackagesSection } from "@/components/proposal/packages-section";
import { PhotosSection } from "@/components/proposal/photos-section";
import { TermsSection } from "@/components/proposal/terms-section";
import { SignaturePad } from "./signature-pad";
import { AcceptBar } from "./accept-bar";
import { AcceptedScreen } from "./accepted-screen";
import { packageTotal, type Proposal } from "@/lib/proposal-mock";

export function ClientPortalView({
  proposal,
  previewMode,
}: {
  proposal: Proposal;
  previewMode?: boolean;
}) {
  const recommended =
    proposal.packages.find((p) => p.recommended)?.id ??
    proposal.packages[1]?.id ??
    proposal.packages[0]?.id;

  const [selectedId, setSelectedId] = useState<string>(recommended);
  const [signature, setSignature] = useState<string | null>(null);
  const [signerName, setSignerName] = useState(proposal.client.name);
  const [agreed, setAgreed] = useState(false);
  const [paymentChoice, setPaymentChoice] = useState<"deposit" | "full">(
    "deposit",
  );
  const [accepted, setAccepted] = useState(false);

  const selected =
    proposal.packages.find((p) => p.id === selectedId) ?? proposal.packages[0];
  const totals = packageTotal(selected, proposal.measurements);

  const canAccept =
    !!signature &&
    signerName.trim().length > 1 &&
    agreed &&
    !previewMode;

  let reason: string | undefined;
  if (previewMode) reason = "Preview mode — accepting is disabled";
  else if (!signature) reason = "Sign above to enable accept";
  else if (signerName.trim().length <= 1) reason = "Add your printed name";
  else if (!agreed) reason = "Acknowledge the terms to continue";

  if (accepted) {
    const due = totals.total * (paymentChoice === "deposit" ? proposal.depositPct / 100 : 1);
    return (
      <AcceptedScreen
        packageName={selected.name}
        amount={due}
        contractor={proposal.contractor}
        signerName={signerName}
      />
    );
  }

  return (
    <div className="relative">
      {!previewMode && <PortalNav proposal={proposal} />}

      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-8"
        >
          <Header proposal={proposal} />

          <AerialSection proposal={proposal} />

          <PackagesSection
            proposal={proposal}
            onChange={() => undefined}
            readOnly
            selectedPackageId={selectedId}
            onSelectPackage={setSelectedId}
          />

          <PhotosSection
            proposal={proposal}
            onChange={() => undefined}
            readOnly
          />

          <TermsSection
            proposal={proposal}
            onChange={() => undefined}
            readOnly
          />

          <section className="space-y-4">
            <h2 className="font-display text-xl font-semibold tracking-tight">
              Sign & accept
            </h2>
            <SignaturePad
              value={signature}
              onChange={setSignature}
              signerName={signerName}
              onSignerName={setSignerName}
            />
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-white/20 bg-white/[0.06] accent-accent-400"
              />
              <span className="text-sm text-zinc-300">
                I authorize {proposal.contractor.company} to perform the
                described scope of work and agree to the terms above. I confirm
                I'm authorized to sign for this property.
              </span>
            </label>
          </section>

          <ContactCard contractor={proposal.contractor} />
          <div className="h-32 print:hidden" />
        </motion.div>
      </main>

      <AcceptBar
        packageName={selected.name}
        total={totals.total}
        depositPct={proposal.depositPct}
        paymentChoice={paymentChoice}
        onPaymentChoice={setPaymentChoice}
        canAccept={canAccept}
        reason={reason}
        onAccept={() => setAccepted(true)}
      />
    </div>
  );
}

function PortalNav({ proposal }: { proposal: Proposal }) {
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-ink-950/85 backdrop-blur-xl print:hidden">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Logo />
        <div className="hidden items-center gap-3 text-xs text-zinc-500 sm:flex">
          <Badge tone="neutral">
            <ShieldCheck className="h-3 w-3" />
            Verified contractor
          </Badge>
          <span>·</span>
          <span>{proposal.contractor.company}</span>
        </div>
      </div>
    </header>
  );
}

function Header({ proposal }: { proposal: Proposal }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.03] to-transparent p-6 sm:p-8">
      <Badge>For {proposal.client.name}</Badge>
      <h1 className="font-display mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Your gutter quote from{" "}
        <span className="text-gradient">{proposal.contractor.company}</span>
      </h1>
      <p className="mt-3 max-w-2xl text-balance text-base leading-relaxed text-zinc-400">
        {proposal.intro}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <Badge tone="neutral">{proposal.address}</Badge>
        <span>·</span>
        <span>Valid for {proposal.validDays} days</span>
        <span>·</span>
        <span>Prepared by {proposal.contractor.name}</span>
      </div>
    </div>
  );
}

function ContactCard({
  contractor,
}: {
  contractor: Proposal["contractor"];
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Questions? Talk to your contractor
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="font-medium text-zinc-100">{contractor.name}</div>
          <div className="text-sm text-zinc-500">{contractor.company}</div>
        </div>
        <a
          href={`tel:${contractor.phone}`}
          className="inline-flex items-center gap-2 text-sm text-zinc-300 hover:text-accent-300"
        >
          <Phone className="h-4 w-4" />
          {contractor.phone}
        </a>
        <a
          href={`mailto:${contractor.email}`}
          className="inline-flex items-center gap-2 text-sm text-zinc-300 hover:text-accent-300"
        >
          <Mail className="h-4 w-4" />
          {contractor.email}
        </a>
      </div>
    </div>
  );
}
