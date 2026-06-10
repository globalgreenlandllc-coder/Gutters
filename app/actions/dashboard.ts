"use server";

import { db } from "@/lib/db";
import { getMe } from "./me";

import type { ProposalListItem } from "@/lib/dashboard-mock";
import { packageTotal, type Proposal } from "@/lib/proposal-mock";

/**
 * Computes a proposal's dollar total from its data blob. Falls through
 * to 0 only if the blob has no packages or measurements.
 *
 * Priority:
 *   1. selectedPackageId — what the contractor/homeowner picked
 *   2. Pro Shield / index 1 — the canonical "most popular" tier the
 *      dashboard already highlights in the estimate view
 *   3. First available package
 *
 * Saves us from the bug where saveDraftFromEstimate was writing
 * totalCents: 0 to the row even though the proposal had real package
 * pricing in its data blob.
 */
function deriveProposalTotalCents(
  data: unknown,
  fallbackCents: number,
): number {
  // Already-priced rows (sent / accepted with real totalCents) keep
  // their stored value. Only $0 rows need derivation.
  if (fallbackCents > 0) return fallbackCents;
  const proposal = data as Partial<Proposal> | null;
  if (!proposal || !Array.isArray(proposal.packages) || !proposal.measurements) {
    return 0;
  }
  const packages = proposal.packages;
  if (packages.length === 0) return 0;
  const selectedId = (proposal as { selectedPackageId?: string }).selectedPackageId;
  const pick =
    (selectedId ? packages.find((p) => p.id === selectedId) : null) ??
    packages[1] ??
    packages[0];
  if (!pick) return 0;
  try {
    const { total } = packageTotal(
      pick,
      proposal.measurements,
      proposal.discountPct ?? 0,
    );
    return Math.max(0, Math.round(total * 100));
  } catch {
    return 0;
  }
}
export type MyProposalRow = ProposalListItem;

export type MyKpis = {
  sent: number;
  accepted: number;
  revenueMtd: number;
  conversion: number;
  pipelineValue: number;
  avgDeal: number;
};

export type MyActivityEvent = {
  id: string;
  kind: "viewed" | "accepted" | "paid" | "sent" | "drafted" | "expired" | "declined";
  client: string;
  proposalId: string;
  message: string;
  at: string;
};

const STATUS_TO_UI: Record<
  | "DRAFT"
  | "SENT"
  | "VIEWED"
  | "ACCEPTED"
  | "DECLINED"
  | "EXPIRED",
  MyProposalRow["status"]
> = {
  DRAFT: "draft",
  SENT: "sent",
  VIEWED: "viewed",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  EXPIRED: "expired",
};

export async function listMyProposals(): Promise<MyProposalRow[]> {
  const me = await getMe();
  if (!me) return [];
  const rows = await db.proposal.findMany({
    where: { userId: me.user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { events: true } },
      events: {
        where: { kind: "VIEWED" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
        take: 50,
      },
    },
  });
  return rows.map((r) => {
    const viewEvents = r.events;
    // Derive the dollar total from the data blob when the row's
    // totalCents column is still 0 (proposals saved before the
    // package-price derivation existed).
    const cents = deriveProposalTotalCents(r.data, r.totalCents);
    return {
      id: r.id,
      address: r.address,
      client: r.clientName,
      clientEmail: r.clientEmail || undefined,
      total: cents / 100,
      status: STATUS_TO_UI[r.status as keyof typeof STATUS_TO_UI] ?? "draft",
      selectedPackage: r.selectedPackageId ?? undefined,
      updatedAt: r.updatedAt.toISOString(),
      views: r._count.events,
      viewCount: viewEvents.length,
      firstViewedAt: viewEvents[0]?.createdAt.toISOString(),
      lastViewedAt: viewEvents[viewEvents.length - 1]?.createdAt.toISOString(),
      paid: r.paidCents > 0 ? r.paidCents / 100 : undefined,
    };
  });
}

/**
 * Loads a proposal by id for the signed-in contractor, returning the
 * full Proposal JSON shape — same one the /proposal editor + send
 * modal expect. Powers (a) opening a saved draft for further editing
 * and (b) the Send-from-list flow on /dashboard/proposals.
 *
 * Returns null when the proposal doesn't exist or belongs to someone
 * else. Doesn't throw on missing — callers redirect or 404.
 */
export async function getMyProposal(id: string): Promise<Proposal | null> {
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch {
    return null;
  }
  if (!me) return null;
  const row = await db.proposal.findFirst({
    where: { id, userId: me.user.id },
    select: {
      data: true,
      address: true,
      clientName: true,
      clientEmail: true,
      publicToken: true,
    },
  });
  if (!row) return null;
  // The `data` column holds a full Proposal JSON blob (what /proposal
  // serializes when saving). Overlay the canonical address / client
  // columns on top in case those were edited via the list-row UI
  // separately from the JSON blob.
  const base = (row.data as unknown as Proposal) ?? null;
  if (!base) return null;
  return {
    ...base,
    token: row.publicToken,
    address: row.address || base.address,
    client: {
      name: row.clientName || base.client?.name || "",
      email: row.clientEmail || base.client?.email || "",
    },
  };
}

export async function getMyKpis(): Promise<MyKpis> {
  const me = await getMe();
  if (!me) {
    return {
      sent: 0,
      accepted: 0,
      revenueMtd: 0,
      conversion: 0,
      pipelineValue: 0,
      avgDeal: 0,
    };
  }
  const userId = me.user.id;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  // Pipeline proposals now fetched WITH their data blobs so we can
  // derive the dollar total for any row where totalCents is still 0
  // (proposals created before the package-price derivation existed
  // still need to count toward the contractor's pipeline view).
  const [sentCount, acceptedThisMonth, allDecided, pipelineRows] =
    await Promise.all([
      db.proposal.count({
        where: {
          userId,
          status: { in: ["SENT", "VIEWED", "ACCEPTED", "DECLINED", "EXPIRED"] },
          updatedAt: { gte: monthStart },
        },
      }),
      db.proposal.findMany({
        where: { userId, status: "ACCEPTED", acceptedAt: { gte: monthStart } },
        select: { paidCents: true, totalCents: true, data: true },
      }),
      db.proposal.findMany({
        where: { userId, status: { in: ["ACCEPTED", "DECLINED"] } },
        select: { status: true },
      }),
      db.proposal.findMany({
        where: {
          userId,
          status: { in: ["DRAFT", "SENT", "VIEWED"] },
        },
        select: { totalCents: true, data: true },
      }),
    ]);

  const acceptedCount = acceptedThisMonth.length;
  const revenueMtd =
    acceptedThisMonth.reduce((sum, p) => sum + p.paidCents, 0) / 100;
  // Accepted-deal totals: derive from data blob when the column says 0.
  const totalAcceptedDollarsMtd =
    acceptedThisMonth.reduce(
      (sum, p) => sum + deriveProposalTotalCents(p.data, p.totalCents),
      0,
    ) / 100;
  const avgDeal = acceptedCount > 0 ? totalAcceptedDollarsMtd / acceptedCount : 0;

  const decidedCount = allDecided.length;
  const decidedAccepted = allDecided.filter((p) => p.status === "ACCEPTED").length;
  const conversion = decidedCount > 0 ? decidedAccepted / decidedCount : 0;
  // Pipeline value: sum derived totals so drafts with package pricing
  // in the data blob (the common case after Save proposal in the
  // estimate top bar) contribute even though the row's totalCents
  // column is 0.
  const pipelineValue =
    pipelineRows.reduce(
      (sum, p) => sum + deriveProposalTotalCents(p.data, p.totalCents),
      0,
    ) / 100;

  return {
    sent: sentCount,
    accepted: acceptedCount,
    revenueMtd,
    conversion,
    pipelineValue,
    avgDeal,
  };
}

export async function listMyActivity(limit = 10): Promise<MyActivityEvent[]> {
  const me = await getMe();
  if (!me) return [];
  const rows = await db.proposalEvent.findMany({
    where: { proposal: { userId: me.user.id } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { proposal: true },
  });
  return rows.map((e) => ({
    id: e.id,
    kind: mapEventKind(e.kind),
    client: e.proposal.clientName,
    proposalId: e.proposalId,
    message: messageForEvent(e.kind, e.proposal.address, e.proposal.clientName),
    at: e.createdAt.toISOString(),
  }));
}

function mapEventKind(
  k: string,
): "viewed" | "accepted" | "paid" | "sent" | "drafted" | "expired" | "declined" {
  switch (k) {
    case "DRAFTED":
      return "drafted";
    case "SENT":
      return "sent";
    case "VIEWED":
      return "viewed";
    case "PACKAGE_SELECTED":
    case "SIGNED":
    case "ACCEPTED":
      return "accepted";
    case "PAID":
      return "paid";
    case "DECLINED":
      return "declined";
    case "EXPIRED":
      return "expired";
    default:
      return "drafted";
  }
}

function messageForEvent(kind: string, address: string, client: string): string {
  switch (kind) {
    case "DRAFTED":
      return `Drafted estimate · ${address}`;
    case "SENT":
      return `Proposal sent to ${client}`;
    case "VIEWED":
      return `${client} opened the proposal`;
    case "PACKAGE_SELECTED":
      return `${client} picked a package`;
    case "SIGNED":
      return `${client} signed the proposal`;
    case "ACCEPTED":
      return `Accepted · ${address}`;
    case "PAID":
      return `Paid · ${address}`;
    case "DECLINED":
      return `Declined · ${address}`;
    case "EXPIRED":
      return `Expired · ${address}`;
    default:
      return `${kind} · ${address}`;
  }
}
