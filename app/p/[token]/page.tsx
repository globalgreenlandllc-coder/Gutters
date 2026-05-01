import { notFound } from "next/navigation";
import { sampleProposal } from "@/lib/proposal-mock";
import { ClientPortalView } from "@/components/client-portal/client-portal-view";
import { getProposalByToken } from "@/app/actions/proposals";

export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length < 3) {
    notFound();
  }

  const real = await getProposalByToken(token);
  if (real) {
    return <ClientPortalView proposal={{ ...real, token }} />;
  }

  // Demo fallback: tokens not backed by a real proposal still render the
  // sample portal so /p/demo-7f3a2 keeps working as a sales preview.
  return <ClientPortalView proposal={{ ...sampleProposal, token }} />;
}
