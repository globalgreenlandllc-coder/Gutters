// Shared types + helpers used by the contractor dashboard.
// The dashboard pulls real data from app/actions/dashboard.ts; only the
// type aliases and timeAgo helper live here now.

export type ProposalStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired";

export type ProposalListItem = {
  id: string;
  address: string;
  client: string;
  total: number;
  status: ProposalStatus;
  selectedPackage?: string;
  updatedAt: string;
  views: number;
  paid?: number;
};

export type ActivityEvent = {
  id: string;
  kind:
    | "viewed"
    | "accepted"
    | "paid"
    | "sent"
    | "drafted"
    | "expired"
    | "declined";
  client: string;
  proposalId: string;
  message: string;
  at: string;
};

export type Kpis = {
  sent: number;
  accepted: number;
  revenueMtd: number;
  conversion: number;
  pipelineValue: number;
  avgDeal: number;
};

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
