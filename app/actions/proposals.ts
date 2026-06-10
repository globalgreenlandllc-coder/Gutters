"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { sendEmailViaResend } from "@/lib/email/resend";
import { renderProposalEmail } from "@/lib/email/proposal-template";
import {
  blankProposal,
  packageTotal,
  type Proposal,
} from "@/lib/proposal-mock";
import type { Downspout, EditableLine, Measurements } from "@/lib/types";
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

/* ------------------------------------------------------------------ */
/*  Draft-save from the estimate view                                  */
/*                                                                     */
/*  The estimate page used to only have "Send proposal", which forced  */
/*  contractors to push to /proposal AND fill in client info before    */
/*  anything got persisted. Save-as-draft persists the takeoff so the  */
/*  job shows up in /dashboard/proposals (status: DRAFT) without       */
/*  needing client email yet — the contractor can come back later to   */
/*  finalize and send.                                                 */
/* ------------------------------------------------------------------ */

export type SaveDraftResult =
  | { ok: true; id: string; token: string; status: "DRAFT" }
  | { ok: false; reason: string };

export async function saveDraftFromEstimate(args: {
  address: string;
  measurements: Measurements;
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
  aerial?: {
    imageDataUrl: string;
    width: number;
    height: number;
    zoom: number;
  };
  /** Optional total in cents. When the user hasn't picked a package yet
   *  the estimate view doesn't have a committed total; pass 0 in that
   *  case — the proposals list will show "Pending" instead of "$0.00". */
  totalCents?: number;
  /** When supplied, updates the existing draft instead of creating a new
   *  row. The estimate top-bar tracks the returned id locally so repeat
   *  clicks update the same proposal. */
  existingId?: string;
  /** Whether this is a new-construction job or a replacement. Stored on
   *  the proposal JSON blob so the scope-of-work language can branch. */
  jobType?: "new" | "replacement";
}): Promise<SaveDraftResult> {
  try {
    return await saveDraftFromEstimateImpl(args);
  } catch (e) {
    // Any throw past this point — DB connection, JSON column overflow,
    // Clerk session lookup — used to bubble to the page boundary as a
    // generic "Server Components render" 500. Now it shows up as the
    // top-bar's red status text.
    console.error("[saveDraftFromEstimate] threw", e);
    const msg = e instanceof Error ? e.message : "Save failed";
    return { ok: false, reason: msg };
  }
}

async function saveDraftFromEstimateImpl(args: {
  address: string;
  measurements: Measurements;
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
  aerial?: {
    imageDataUrl: string;
    width: number;
    height: number;
    zoom: number;
  };
  totalCents?: number;
  existingId?: string;
  jobType?: "new" | "replacement";
}): Promise<SaveDraftResult> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  if (!args.address.trim()) {
    return { ok: false, reason: "Address is required" };
  }

  // Compose a Proposal-shaped JSON blob so /proposal can re-hydrate the
  // draft later. We start from the blank template and overlay the live
  // estimate data + the contractor's profile.
  // jobType is stored as an extra key on the proposal JSON blob — not in
  // the typed Proposal shape (which would require a schema migration), but
  // accessible via `data.jobType` in any downstream code that wants to
  // branch scope-of-work text on it.
  const blank = blankProposal();
  const draft: Proposal & { jobType?: "new" | "replacement" } = {
    ...blank,
    token: randomBytes(12).toString("hex"),
    jobType: args.jobType ?? "replacement",
    address: args.address,
    measurements: args.measurements,
    takeoff: {
      eaves: args.eaves,
      rakes: args.rakes,
      downspouts: args.downspouts,
      aerial: args.aerial,
    },
    contractor: {
      name: me.profile.contractorName || me.user.name,
      company: me.profile.company,
      phone: me.profile.phone,
      email: me.profile.email,
      license: me.profile.license,
      stripePaymentUrl: me.profile.payments.stripeUrl ?? null,
      squarePaymentUrl: me.profile.payments.squareUrl ?? null,
    },
  };

  const dataJson = draft as unknown as Prisma.InputJsonValue;
  const contractorSnap = draft.contractor as unknown as Prisma.InputJsonValue;

  // Derive a sensible totalCents from the package pricing instead of
  // always falling back to 0. The estimate top-bar currently passes 0
  // because no package has been selected — pick the canonical 'Pro
  // Shield' (middle tier) so the proposals list + dashboard pipeline
  // both reflect a real number instead of $0 everywhere.
  let totalCents = Math.max(0, Math.round(args.totalCents ?? 0));
  if (totalCents === 0 && draft.packages.length > 0) {
    const pick = draft.packages[1] ?? draft.packages[0];
    try {
      const { total } = packageTotal(pick, args.measurements);
      totalCents = Math.max(0, Math.round(total * 100));
    } catch {
      // packageTotal can throw on malformed measurements — fall back to 0.
    }
  }

  // Update path: contractor has clicked Save more than once on this estimate.
  const existing = args.existingId
    ? await db.proposal.findFirst({
        where: { id: args.existingId, userId: me.user.id },
        select: { id: true, publicToken: true, status: true },
      })
    : null;

  // Never downgrade an already-sent proposal back to DRAFT via this path —
  // the dedicated send action owns the SENT→DRAFT rollback on email failure.
  if (existing && existing.status !== "DRAFT") {
    return {
      ok: false,
      reason: `Proposal is already ${existing.status.toLowerCase()}; create a new one instead.`,
    };
  }

  const row = existing
    ? await db.proposal.update({
        where: { id: existing.id },
        data: {
          address: args.address,
          // Don't clobber clientName/clientEmail if the contractor already
          // typed them into /proposal — those live in the proposal `data`
          // blob too, but the columns are what the dashboard table reads.
          totalCents,
          data: dataJson,
          contractorSnap,
        },
        select: { id: true, publicToken: true },
      })
    : await db.proposal.create({
        data: {
          userId: me.user.id,
          publicToken: draft.token,
          address: args.address,
          // Empty client info on first save — filled in when the contractor
          // navigates to /proposal to finalize and send.
          clientName: "",
          clientEmail: "",
          status: "DRAFT",
          totalCents,
          data: dataJson,
          contractorSnap,
        },
        select: { id: true, publicToken: true },
      });

  revalidatePath("/dashboard/proposals");

  return { ok: true, id: row.id, token: row.publicToken, status: "DRAFT" };
}
