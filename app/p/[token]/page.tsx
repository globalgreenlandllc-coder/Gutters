import { notFound } from "next/navigation";
import { sampleProposal } from "@/lib/proposal-mock";
import { ClientPortalView } from "@/components/client-portal/client-portal-view";

export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length < 3) {
    notFound();
  }
  return <ClientPortalView proposal={{ ...sampleProposal, token }} />;
}
