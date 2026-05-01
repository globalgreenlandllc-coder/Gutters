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

export const mockProposals: ProposalListItem[] = [
  {
    id: "demo-7f3a2",
    address: "1247 Maple Ridge Dr, Austin, TX",
    client: "Sarah & Mike Chen",
    total: 7820,
    status: "viewed",
    updatedAt: "2026-04-29T10:14:00Z",
    views: 3,
  },
  {
    id: "p-902a",
    address: "82 Lakeshore Ave, Oakland, CA",
    client: "Daniel Park",
    total: 6140,
    status: "accepted",
    selectedPackage: "Pro Shield",
    paid: 1842,
    updatedAt: "2026-04-28T15:42:00Z",
    views: 5,
  },
  {
    id: "p-411c",
    address: "411 Cedar Glen, Dallas, TX",
    client: "Emily Ross",
    total: 6420,
    status: "accepted",
    selectedPackage: "Pro Shield",
    paid: 6420,
    updatedAt: "2026-04-26T09:02:00Z",
    views: 8,
  },
  {
    id: "p-9203",
    address: "9203 Oak Hill Rd, Austin, TX",
    client: "Marcus Greene",
    total: 5240,
    status: "sent",
    updatedAt: "2026-04-25T18:31:00Z",
    views: 1,
  },
  {
    id: "p-514b",
    address: "514 Birchwood Lane, Charlotte, NC",
    client: "Priya Natarajan",
    total: 4980,
    status: "draft",
    updatedAt: "2026-04-25T11:08:00Z",
    views: 0,
  },
  {
    id: "p-728p",
    address: "728 Pine Ridge, Boulder, CO",
    client: "Jason Webb",
    total: 9120,
    status: "expired",
    updatedAt: "2026-03-28T08:55:00Z",
    views: 4,
  },
  {
    id: "p-301h",
    address: "301 Highland Pl, Phoenix, AZ",
    client: "Alyssa Mendez",
    total: 5750,
    status: "declined",
    updatedAt: "2026-04-21T13:20:00Z",
    views: 2,
  },
  {
    id: "p-066o",
    address: "66 Orchard St, Brooklyn, NY",
    client: "Tomás Rivera",
    total: 11240,
    status: "accepted",
    selectedPackage: "Heritage Copper",
    paid: 3372,
    updatedAt: "2026-04-19T17:00:00Z",
    views: 6,
  },
];

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

export const mockActivity: ActivityEvent[] = [
  {
    id: "a1",
    kind: "paid",
    client: "Emily Ross",
    proposalId: "p-411c",
    message: "Paid in full · $6,420.00",
    at: "2026-04-30T08:22:00Z",
  },
  {
    id: "a2",
    kind: "viewed",
    client: "Sarah & Mike Chen",
    proposalId: "demo-7f3a2",
    message: "Opened proposal · 3rd view",
    at: "2026-04-29T22:14:00Z",
  },
  {
    id: "a3",
    kind: "accepted",
    client: "Daniel Park",
    proposalId: "p-902a",
    message: "Accepted Pro Shield · 30% deposit",
    at: "2026-04-28T15:42:00Z",
  },
  {
    id: "a4",
    kind: "sent",
    client: "Marcus Greene",
    proposalId: "p-9203",
    message: "Proposal sent",
    at: "2026-04-25T18:31:00Z",
  },
  {
    id: "a5",
    kind: "drafted",
    client: "Priya Natarajan",
    proposalId: "p-514b",
    message: "Estimate drafted · awaiting send",
    at: "2026-04-25T11:08:00Z",
  },
];

export type Kpis = {
  sent: number;
  accepted: number;
  revenueMtd: number;
  conversion: number;
  pipelineValue: number;
  avgDeal: number;
};

export function computeKpis(items: ProposalListItem[]): Kpis {
  const month = new Date().getUTCMonth();
  const inMonth = items.filter(
    (p) => new Date(p.updatedAt).getUTCMonth() === month,
  );
  const sent = inMonth.filter((p) =>
    ["sent", "viewed", "accepted", "declined", "expired"].includes(p.status),
  ).length;
  const accepted = inMonth.filter((p) => p.status === "accepted").length;
  const revenueMtd = inMonth
    .filter((p) => p.status === "accepted")
    .reduce((acc, p) => acc + (p.paid ?? 0), 0);
  const pipelineValue = items
    .filter((p) => ["sent", "viewed", "draft"].includes(p.status))
    .reduce((acc, p) => acc + p.total, 0);
  const decided = items.filter((p) =>
    ["accepted", "declined"].includes(p.status),
  );
  const conv =
    decided.length === 0
      ? 0
      : decided.filter((p) => p.status === "accepted").length / decided.length;
  const avgDeal =
    accepted === 0
      ? 0
      : inMonth
          .filter((p) => p.status === "accepted")
          .reduce((acc, p) => acc + p.total, 0) / accepted;
  return {
    sent,
    accepted,
    revenueMtd,
    conversion: conv,
    pipelineValue,
    avgDeal,
  };
}

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
