"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  clearImpersonationCookie,
  setImpersonationCookie,
} from "@/lib/impersonation";
import { getMe } from "./me";

async function requireAdmin() {
  const me = await getMe();
  if (!me || me.user.role !== "SUPER_ADMIN") {
    throw new Error("Forbidden");
  }
  return me;
}

async function logAction(
  actorId: string,
  action:
    | "USER_SUSPENDED"
    | "USER_UNSUSPENDED"
    | "USER_CREDITS_ADJUSTED"
    | "USER_IMPERSONATED"
    | "USER_IMPERSONATION_ENDED"
    | "REFUND_ISSUED"
    | "API_KEY_CREATED"
    | "API_KEY_ROTATED"
    | "API_KEY_REVOKED"
    | "API_KEY_VIEWED"
    | "PRICING_UPDATED"
    | "MATERIAL_DEFAULTS_UPDATED",
  targetType: string | null,
  targetId: string | null,
  payload: Record<string, unknown> = {},
) {
  await db.auditLog.create({
    data: {
      actorId,
      action,
      targetType,
      targetId,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  role: "CONTRACTOR" | "SUPER_ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  lastLoginAt: string | null;
  company: string;
  contractorName: string;
  creditsIncluded: number;
  creditsUsed: number;
  creditsBonus: number;
  remaining: number;
  estimateRunsTotal: number;
  proposalsTotal: number;
  acceptedTotal: number;
  revenueProcessedCents: number;
  payments: {
    stripe: boolean;
    square: boolean;
  };
};

export async function listUsersForAdmin(): Promise<AdminUserRow[]> {
  await requireAdmin();
  const users = await db.user.findMany({
    include: {
      contractorProfile: true,
      creditWallet: true,
      _count: {
        select: { estimateRuns: true, proposals: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const ids = users.map((u) => u.id);
  const accepted = await db.proposal.groupBy({
    by: ["userId"],
    where: { status: "ACCEPTED", userId: { in: ids } },
    _count: { _all: true },
    _sum: { paidCents: true },
  });
  const acceptedById = new Map(
    accepted.map((a) => [
      a.userId,
      { count: a._count._all, paid: a._sum.paidCents ?? 0 },
    ]),
  );

  return users.map((u) => {
    const total =
      (u.creditWallet?.included ?? 0) + (u.creditWallet?.bonus ?? 0);
    const used = u.creditWallet?.used ?? 0;
    const a = acceptedById.get(u.id) ?? { count: 0, paid: 0 };
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role as "CONTRACTOR" | "SUPER_ADMIN",
      status: u.status as "ACTIVE" | "SUSPENDED",
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      company: u.contractorProfile?.company ?? "",
      contractorName: u.contractorProfile?.contractorName ?? "",
      creditsIncluded: u.creditWallet?.included ?? 0,
      creditsUsed: used,
      creditsBonus: u.creditWallet?.bonus ?? 0,
      remaining: Math.max(total - used, 0),
      estimateRunsTotal: u._count.estimateRuns,
      proposalsTotal: u._count.proposals,
      acceptedTotal: a.count,
      revenueProcessedCents: a.paid,
      payments: {
        stripe: !!u.contractorProfile?.stripePaymentUrl,
        square: !!u.contractorProfile?.squarePaymentUrl,
      },
    };
  });
}

export async function adjustCredits(
  userId: string,
  delta: number,
  reason: string,
): Promise<{ ok: true; remaining: number }> {
  const me = await requireAdmin();
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("Delta must be a non-zero integer");
  }
  const updated = await db.creditWallet.update({
    where: { userId },
    data:
      delta > 0
        ? { bonus: { increment: delta } }
        : { used: { increment: Math.max(0, -delta) } },
  });

  await logAction(me.user.id, "USER_CREDITS_ADJUSTED", "User", userId, {
    delta,
    reason,
    after: {
      included: updated.included,
      used: updated.used,
      bonus: updated.bonus,
    },
  });
  revalidatePath("/admin/users");
  revalidatePath("/admin");

  const remaining = Math.max(
    updated.included + updated.bonus - updated.used,
    0,
  );
  return { ok: true, remaining };
}

export async function setUserStatus(
  userId: string,
  status: "ACTIVE" | "SUSPENDED",
  reason?: string,
): Promise<{ ok: true }> {
  const me = await requireAdmin();
  const before = await db.user.findUnique({ where: { id: userId } });
  if (!before) throw new Error("User not found");
  if (before.role === "SUPER_ADMIN" && status === "SUSPENDED") {
    throw new Error("Cannot suspend a super admin");
  }
  await db.user.update({ where: { id: userId }, data: { status } });
  await logAction(
    me.user.id,
    status === "SUSPENDED" ? "USER_SUSPENDED" : "USER_UNSUSPENDED",
    "User",
    userId,
    { reason: reason ?? null, prior: before.status },
  );
  revalidatePath("/admin/users");
  return { ok: true };
}

export type AdminKpis = {
  contractorsActive: number;
  contractorsSuspended: number;
  estimatesThisMonth: number;
  estimatesAllTime: number;
  proposalsAccepted: number;
  revenueProcessedCents: number;
  platformFeesCents: number;
  mrrCents: number;
};

export async function getAdminKpis(): Promise<AdminKpis> {
  await requireAdmin();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [
    contractorsActive,
    contractorsSuspended,
    estimatesThisMonth,
    estimatesAllTime,
    proposalsAccepted,
    revenueAgg,
    feesAgg,
    activeSubs,
  ] = await Promise.all([
    db.user.count({ where: { role: "CONTRACTOR", status: "ACTIVE" } }),
    db.user.count({ where: { role: "CONTRACTOR", status: "SUSPENDED" } }),
    db.estimateRun.count({ where: { createdAt: { gte: monthStart } } }),
    db.estimateRun.count(),
    db.proposal.count({ where: { status: "ACCEPTED" } }),
    db.proposal.aggregate({
      where: { status: "ACCEPTED" },
      _sum: { paidCents: true },
    }),
    db.transaction.aggregate({
      where: {
        status: "SUCCEEDED",
        type: { in: ["PROPOSAL_DEPOSIT", "PROPOSAL_FINAL"] },
      },
      _sum: { platformFeeCents: true },
    }),
    db.subscription.count({ where: { status: "ACTIVE" } }),
  ]);

  return {
    contractorsActive,
    contractorsSuspended,
    estimatesThisMonth,
    estimatesAllTime,
    proposalsAccepted,
    revenueProcessedCents: revenueAgg._sum.paidCents ?? 0,
    platformFeesCents: feesAgg._sum.platformFeeCents ?? 0,
    mrrCents: activeSubs * 5000,
  };
}

export type AdminFinancials = {
  mrrCents: number;
  activeSubs: number;
  pastDueSubs: number;
  revenue30dCents: number;
  subscriptionRevenue30dCents: number;
  creditRevenue30dCents: number;
  allTimeRevenueCents: number;
  transactions: Array<{
    id: string;
    userEmail: string;
    type: string;
    status: string;
    grossCents: number;
    description: string | null;
    createdAt: string;
  }>;
};

/**
 * Platform revenue view for /admin/financials. All rows come from the
 * Transaction ledger the Stripe webhook writes (subscriptions +
 * credit top-ups) — empty until Stripe keys are configured and the
 * first payment lands.
 */
export async function getAdminFinancials(): Promise<AdminFinancials> {
  await requireAdmin();
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [activeSubs, pastDueSubs, sub30, credit30, allTime, recent] =
    await Promise.all([
      db.subscription.count({ where: { status: "ACTIVE" } }),
      db.subscription.count({ where: { status: "PAST_DUE" } }),
      db.transaction.aggregate({
        where: {
          status: "SUCCEEDED",
          type: "SUBSCRIPTION",
          createdAt: { gte: since30d },
        },
        _sum: { grossCents: true },
      }),
      db.transaction.aggregate({
        where: {
          status: "SUCCEEDED",
          type: "CREDIT_TOPUP",
          createdAt: { gte: since30d },
        },
        _sum: { grossCents: true },
      }),
      db.transaction.aggregate({
        where: { status: "SUCCEEDED" },
        _sum: { grossCents: true },
      }),
      db.transaction.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        include: { user: { select: { email: true } } },
      }),
    ]);

  const subscriptionRevenue30dCents = sub30._sum.grossCents ?? 0;
  const creditRevenue30dCents = credit30._sum.grossCents ?? 0;

  return {
    mrrCents: activeSubs * 5000,
    activeSubs,
    pastDueSubs,
    revenue30dCents: subscriptionRevenue30dCents + creditRevenue30dCents,
    subscriptionRevenue30dCents,
    creditRevenue30dCents,
    allTimeRevenueCents: allTime._sum.grossCents ?? 0,
    transactions: recent.map((t) => ({
      id: t.id,
      userEmail: t.user.email,
      type: t.type,
      status: t.status,
      grossCents: t.grossCents,
      description: t.description,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

export async function startImpersonation(
  targetUserId: string,
  reason: string,
): Promise<{ ok: true; targetEmail: string }> {
  const me = await requireAdmin();

  if (me.impersonation) {
    throw new Error(
      "You're already impersonating — end the current session before starting a new one.",
    );
  }

  if (targetUserId === me.user.id) {
    throw new Error("You can't impersonate yourself.");
  }

  const target = await db.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new Error("Target user not found");
  if (target.role === "SUPER_ADMIN") {
    throw new Error("Cannot impersonate another super admin.");
  }
  if (target.status === "SUSPENDED") {
    throw new Error(
      "Cannot impersonate a suspended user — reinstate them first if you need to debug.",
    );
  }

  const session = await db.impersonationSession.create({
    data: {
      adminId: me.user.id,
      userId: targetUserId,
      reason: reason.trim() || null,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: me.user.id,
      action: "USER_IMPERSONATED",
      targetType: "User",
      targetId: targetUserId,
      payload: {
        sessionId: session.id,
        targetEmail: target.email,
        reason: reason.trim() || null,
      } as Prisma.InputJsonValue,
    },
  });

  await setImpersonationCookie(session.id);
  revalidatePath("/", "layout");
  return { ok: true, targetEmail: target.email };
}

export async function endImpersonation(): Promise<{ ok: true }> {
  const { readImpersonationSessionId } = await import("@/lib/impersonation");
  const sessionId = await readImpersonationSessionId();
  if (!sessionId) {
    await clearImpersonationCookie();
    return { ok: true };
  }
  const session = await db.impersonationSession.findUnique({
    where: { id: sessionId },
  });
  if (session && !session.endedAt) {
    const startedMs = session.startedAt.getTime();
    await db.impersonationSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() },
    });
    await db.auditLog.create({
      data: {
        actorId: session.adminId,
        action: "USER_IMPERSONATION_ENDED",
        targetType: "User",
        targetId: session.userId,
        payload: {
          sessionId: session.id,
          durationMs: Date.now() - startedMs,
        } as Prisma.InputJsonValue,
      },
    });
  }
  await clearImpersonationCookie();
  revalidatePath("/", "layout");
  return { ok: true };
}

export type AdminActivityRow = {
  id: string;
  kind: "PROPOSAL" | "USER";
  message: string;
  at: string;
};

export async function recentAdminActivity(): Promise<AdminActivityRow[]> {
  await requireAdmin();
  const recent = await db.proposalEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { proposal: { include: { user: true } } },
  });
  return recent.map((e) => ({
    id: e.id,
    kind: "PROPOSAL",
    message: `${e.proposal.user.email} · ${e.kind.toLowerCase().replace("_", " ")} on ${e.proposal.address}`,
    at: e.createdAt.toISOString(),
  }));
}
