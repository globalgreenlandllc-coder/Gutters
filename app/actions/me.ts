"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import {
  IMPERSONATION_MAX_AGE_MS,
  clearImpersonationCookie,
  readImpersonationSessionId,
} from "@/lib/impersonation";
import type {
  ContractorProfile,
  Credits,
  LogoTone,
} from "@/lib/auth-mock";

export type Impersonation = {
  sessionId: string;
  adminUserId: string;
  adminEmail: string;
  startedAt: string;
  reason: string | null;
};

export type MeData = {
  user: {
    id: string;
    clerkId: string;
    email: string;
    name: string;
    role: "CONTRACTOR" | "SUPER_ADMIN";
    status: "ACTIVE" | "SUSPENDED";
  };
  profile: ContractorProfile;
  credits: Credits;
  impersonation?: Impersonation;
};

function nextMonthBoundary(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0),
  );
}

function deriveContractorName(
  fullName: string | null,
  email: string,
): string {
  if (fullName && fullName.trim().length > 0) return fullName.trim();
  const local = email.split("@")[0] ?? "Contractor";
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ");
}

function deriveInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .filter(Boolean);
  if (parts.length === 0) return "GU";
  return parts.slice(0, 2).join("");
}

const TONES_CYCLE: LogoTone[] = [
  "emerald",
  "sky",
  "indigo",
  "amber",
  "rose",
  "violet",
];

function pickTone(seed: string): LogoTone {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return TONES_CYCLE[hash % TONES_CYCLE.length];
}

function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

type DbUserWithRelations = NonNullable<
  Awaited<ReturnType<typeof findOrCreateUser>>
>;

async function findOrCreateUser(
  clerkId: string,
  email: string,
  fullName: string | null,
) {
  const targetRole = isAdminEmail(email) ? "SUPER_ADMIN" : "CONTRACTOR";

  let user = await db.user.findFirst({
    where: { OR: [{ clerkId }, { email }] },
    include: { contractorProfile: true, creditWallet: true },
  });

  if (!user) {
    const contractorName = deriveContractorName(fullName, email);
    const initials = deriveInitials(contractorName);
    const tone = pickTone(clerkId);
    user = await db.user.create({
      data: {
        clerkId,
        email,
        name: fullName,
        role: targetRole,
        lastLoginAt: new Date(),
        contractorProfile: {
          create: {
            company: contractorName,
            contractorName,
            email,
            phone: "",
            license: "",
            tagline: "",
            logoInitials: initials,
            logoTone: tone,
          },
        },
        creditWallet: {
          create: {
            included: 12,
            used: 0,
            bonus: 0,
            resetsAt: nextMonthBoundary(),
          },
        },
      },
      include: { contractorProfile: true, creditWallet: true },
    });
    return user;
  }

  const updates: Record<string, unknown> = { lastLoginAt: new Date() };
  if (user.clerkId !== clerkId) updates.clerkId = clerkId;
  if (user.email !== email) updates.email = email;
  if (user.role !== targetRole) updates.role = targetRole;
  await db.user.update({ where: { id: user.id }, data: updates });

  if (!user.contractorProfile) {
    const contractorName = deriveContractorName(user.name ?? fullName, email);
    const initials = deriveInitials(contractorName);
    const tone = pickTone(clerkId);
    await db.contractorProfile.create({
      data: {
        userId: user.id,
        company: contractorName,
        contractorName,
        email,
        phone: "",
        license: "",
        tagline: "",
        logoInitials: initials,
        logoTone: tone,
      },
    });
  }
  if (!user.creditWallet) {
    await db.creditWallet.create({
      data: {
        userId: user.id,
        included: 12,
        used: 0,
        bonus: 0,
        resetsAt: nextMonthBoundary(),
      },
    });
  }

  return db.user.findUnique({
    where: { id: user.id },
    include: { contractorProfile: true, creditWallet: true },
  });
}

function shape(
  user: DbUserWithRelations,
  clerkId: string,
  fallbackEmail: string,
  fallbackName: string | null,
  impersonation?: Impersonation,
): MeData {
  const cp = user.contractorProfile;
  const cw = user.creditWallet;
  return {
    user: {
      id: user.id,
      clerkId,
      email: user.email,
      name: fallbackName ?? cp?.contractorName ?? user.email,
      role: user.role as "CONTRACTOR" | "SUPER_ADMIN",
      status: user.status as "ACTIVE" | "SUSPENDED",
    },
    profile: {
      company: cp?.company ?? "",
      contractorName: cp?.contractorName ?? "",
      email: cp?.email ?? user.email,
      phone: cp?.phone ?? "",
      license: cp?.license ?? "",
      tagline: cp?.tagline ?? "",
      logo: {
        initials: cp?.logoInitials ?? "GU",
        tone: (cp?.logoTone as LogoTone) ?? "emerald",
      },
    },
    credits: {
      included: cw?.included ?? 12,
      used: cw?.used ?? 0,
      bonus: cw?.bonus ?? 0,
      resetsAt: (cw?.resetsAt ?? nextMonthBoundary()).toISOString(),
    },
    impersonation,
  };
}

export async function getMe(): Promise<MeData | null> {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email =
    clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;

  const fullName =
    clerkUser.fullName ||
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
    null;

  const adminUser = await findOrCreateUser(clerkId, email, fullName);
  if (!adminUser) return null;

  if (adminUser.role === "SUPER_ADMIN") {
    const sessionId = await readImpersonationSessionId();
    if (sessionId) {
      const session = await db.impersonationSession.findUnique({
        where: { id: sessionId },
        include: {
          admin: true,
          user: { include: { contractorProfile: true, creditWallet: true } },
        },
      });
      const valid =
        session &&
        !session.endedAt &&
        session.adminId === adminUser.id &&
        Date.now() - session.startedAt.getTime() < IMPERSONATION_MAX_AGE_MS &&
        session.user.role !== "SUPER_ADMIN";

      if (valid) {
        return shape(
          session.user,
          session.user.clerkId ?? "",
          session.user.email,
          session.user.name,
          {
            sessionId: session.id,
            adminUserId: session.adminId,
            adminEmail: session.admin.email,
            startedAt: session.startedAt.toISOString(),
            reason: session.reason,
          },
        );
      }
      await clearImpersonationCookie();
    }
  }

  return shape(adminUser, clerkId, email, fullName);
}

export async function updateMyProfile(
  patch: Partial<ContractorProfile>,
): Promise<MeData | null> {
  const me = await getMe();
  if (!me) return null;

  const data: Record<string, unknown> = {};
  if (patch.company !== undefined) data.company = patch.company;
  if (patch.contractorName !== undefined)
    data.contractorName = patch.contractorName;
  if (patch.email !== undefined) data.email = patch.email;
  if (patch.phone !== undefined) data.phone = patch.phone;
  if (patch.license !== undefined) data.license = patch.license;
  if (patch.tagline !== undefined) data.tagline = patch.tagline;
  if (patch.logo?.initials !== undefined)
    data.logoInitials = patch.logo.initials;
  if (patch.logo?.tone !== undefined) data.logoTone = patch.logo.tone;

  await db.contractorProfile.update({
    where: { userId: me.user.id },
    data,
  });

  return getMe();
}

export async function consumeMyCredit(address: string): Promise<{
  ok: boolean;
  reused: boolean;
  remaining: number;
  reason?: string;
}> {
  const me = await getMe();
  if (!me) return { ok: false, reused: false, remaining: 0, reason: "Not signed in" };

  const userId = me.user.id;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const norm = address.trim().toLowerCase();

  const recentSame = await db.estimateRun.count({
    where: {
      userId,
      addressNormalized: norm,
      createdAt: { gte: since },
    },
  });

  if (recentSame >= 10) {
    return {
      ok: false,
      reused: false,
      remaining: me.credits.included + me.credits.bonus - me.credits.used,
      reason: "Same address has been re-run 10 times in the last 24 hours.",
    };
  }

  if (recentSame > 0) {
    await db.estimateRun.create({
      data: {
        userId,
        address,
        addressNormalized: norm,
        status: "SUCCEEDED",
        creditConsumed: false,
        reused: true,
      },
    });
    return {
      ok: true,
      reused: true,
      remaining: me.credits.included + me.credits.bonus - me.credits.used,
    };
  }

  const total = me.credits.included + me.credits.bonus;
  if (me.credits.used >= total) {
    return {
      ok: false,
      reused: false,
      remaining: 0,
      reason: "Out of credits — upgrade or wait until the next renewal.",
    };
  }

  await db.$transaction([
    db.creditWallet.update({
      where: { userId },
      data: { used: { increment: 1 } },
    }),
    db.estimateRun.create({
      data: {
        userId,
        address,
        addressNormalized: norm,
        status: "SUCCEEDED",
        creditConsumed: true,
        reused: false,
      },
    }),
  ]);

  return {
    ok: true,
    reused: false,
    remaining: total - me.credits.used - 1,
  };
}
