import { notFound } from "next/navigation";
import { sampleProposal } from "@/lib/proposal-mock";
import { ClientPortalView } from "@/components/client-portal/client-portal-view";

export default function PublicProposalPage({
  params,
}: {
  params: { token: string };
}) {
  const proposal = sampleProposal;
  if (!params.token || params.token.length < 3) {
    notFound();
  }
  return <ClientPortalView proposal={{ ...proposal, token: params.token }} />;
}
