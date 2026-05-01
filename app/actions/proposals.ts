"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { sendEmailViaResend } from "@/lib/email/resend";
import { renderProposalEmail } from "@/lib/email/proposal-template";
import type { Proposal } from "@/lib/proposal-mock";
import { getMe } from "./me";

export type SendProposalResult =
  | { ok: true; token: string; portalUrl: string; messageId: string }
  | { ok: false; reason: string };

/**
 * Persists the in-memory proposal draft to the database and emails the
 * homeowner a magic link to /p/[token]. Idempotent on a stable token —
 * calling this twice with the same `proposal.token` updates the existing row
 * and sends a fresh email.
 */
export async function sendProposal(args: {
  proposal: Proposal;
  subject: string;
  message: string;
}): Promise<SendProposalResult> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };

  const { proposal, subject, message } = args;

  if (!proposal.client.email || !isPlausibleEmail(proposal.client.email)) {
    return { ok: false, reason: "Client email is missing or invalid" };
  }
  if (!proposal.client.name.trim()) {
    return { ok: false, reason: "Client name is required before sending" };
  }
  if (!proposal.address.trim()) {
    return { ok: false, reason: "Property address is required before sending" };
  }

  // Persist (or update) the proposal so /p/[token] resolves to real data.
  const data = proposal as unknown as Prisma.InputJsonValue;
  const contractorSnap = proposal.contractor as unknown as Prisma.InputJsonValue;

  const existing = proposal.token
    ? await db.proposal.findUnique({ where: { publicToken: proposal.token } })
    : null;

  const row = existing
    ? await db.proposal.update({
        where: { id: existing.id },
        data: {
          address: proposal.address,
          clientName: proposal.client.name,
          clientEmail: proposal.client.email,
          data,
          contractorSnap,
          status: "SENT",
          sentAt: new Date(),
          expiresAt: addDays(new Date(), proposal.validDays || 30),
        },
      })
    : await db.proposal.create({
        data: {
          userId: me.user.id,
          publicToken: proposal.token,
          address: proposal.address,
          clientName: proposal.client.name,
          clientEmail: proposal.client.email,
          status: "SENT",
          data,
          contractorSnap,
          sentAt: new Date(),
          expiresAt: addDays(new Date(), proposal.validDays || 30),
        },
      });

  const portalUrl = `${appBaseUrl()}/p/${row.publicToken}`;

  // Build + send the email
  const { html, text } = renderProposalEmail({
    clientFirstName:
      proposal.client.name.trim().split(/\s+/)[0] || proposal.client.name,
    contractorName: proposal.contractor.name || me.user.name,
    contractorCompany: proposal.contractor.company || me.profile.company,
    contractorPhone: proposal.contractor.phone || me.profile.phone,
    contractorEmail: proposal.contractor.email || me.user.email,
    address: proposal.address,
    validDays: proposal.validDays || 30,
    portalUrl,
    message,
  });

  const result = await sendEmailViaResend({
    to: proposal.client.email,
    fromName: proposal.contractor.company || me.profile.company || "Gutters",
    replyTo: proposal.contractor.email || me.user.email,
    subject: subject.trim() || `Your gutter proposal — ${proposal.address}`,
    html,
    text,
  });

  if (!result.ok) {
    // Roll the status back to DRAFT so the contractor can retry; a SENT row
    // without a delivered email would mislead the dashboard.
    await db.proposal.update({
      where: { id: row.id },
      data: { status: "DRAFT", sentAt: null },
    });
    return { ok: false, reason: result.reason };
  }

  await db.proposalEvent.create({
    data: {
      proposalId: row.id,
      kind: "SENT",
      payload: {
        to: proposal.client.email,
        messageId: result.id,
      } as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/dashboard/proposals");
  revalidatePath("/admin");

  return {
    ok: true,
    token: row.publicToken,
    portalUrl,
    messageId: result.id,
  };
}

/**
 * Resolves the public proposal page. Returns the persisted proposal data
 * if the token matches a real row, otherwise null. Caller decides whether
 * to fall back to sample data.
 */
export async function getProposalByToken(
  token: string,
): Promise<Proposal | null> {
  if (!token) return null;
  const row = await db.proposal.findUnique({
    where: { publicToken: token },
  });
  if (!row) return null;

  // Best-effort viewed event — never throw for analytics.
  try {
    const h = await headers();
    await db.proposalEvent.create({
      data: {
        proposalId: row.id,
        kind: "VIEWED",
        ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: h.get("user-agent") ?? null,
      },
    });
    if (row.status === "SENT") {
      await db.proposal.update({
        where: { id: row.id },
        data: { status: "VIEWED" },
      });
    }
  } catch {
    // ignore
  }

  return row.data as unknown as Proposal;
}

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function appBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}
