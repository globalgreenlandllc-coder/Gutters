"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { getMe } from "@/app/actions/me";
import { appBaseUrl } from "@/lib/base-url";
import { sendEmailViaResend } from "@/lib/email/resend";
import { renderWorkerInviteEmail, renderJobOfferEmail } from "@/lib/email/worker-templates";
import { buildWorkerRoofSnapshot, JOB_KIND_LABEL } from "@/lib/worker-dto";
import { checkUserEmailBudget } from "@/lib/abuse/guards";
import type { JobKind, JobAssignmentStatus, WorkerStatus } from "@prisma/client";

/**
 * workers.ts — OWNER-side crew management + job assignment. Every query is
 * scoped to the signed-in owner's user id (per-user tenancy, no orgs). Owner
 * pricing never enters a JobAssignment: the owner sets the WORKER's pay, and the
 * roof snapshot is built price-free via buildWorkerRoofSnapshot.
 */

export type OwnerWorkerDTO = {
  id: string;
  email: string;
  name: string | null;
  trade: string | null;
  status: WorkerStatus;
  /** True once the invited person signed up and linked their account. */
  linked: boolean;
  invitedAt: string;
  acceptedAt: string | null;
  stats: { offered: number; active: number; completed: number };
};

export type AssignableProposalDTO = {
  id: string;
  address: string;
  clientName: string;
  jobType: string | null;
  hasRoof: boolean;
};

export type OwnerJobDTO = {
  id: string;
  workerId: string;
  workerName: string;
  workerStatus: WorkerStatus;
  status: JobAssignmentStatus;
  title: string;
  address: string;
  clientName: string | null;
  kind: JobKind;
  kindLabel: string;
  scope: string | null;
  workerPayCents: number;
  startsAt: string;
  endsAt: string;
  declineReason: string | null;
  proposalId: string | null;
  createdAt: string;
};

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };
type VoidResult = { ok: true } | { ok: false; reason: string };

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

const ACTIVE_JOB_STATUSES: JobAssignmentStatus[] = ["OFFERED", "ACCEPTED", "IN_PROGRESS"];

// ── Workers ─────────────────────────────────────────────────────────────────

export async function listWorkers(): Promise<OwnerWorkerDTO[]> {
  const me = await getMe();
  if (!me) return [];
  const workers = await db.worker.findMany({
    where: { ownerId: me.user.id },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      jobs: { select: { status: true } },
    },
  });
  return workers.map((w) => {
    const offered = w.jobs.filter((j) => j.status === "OFFERED").length;
    const active = w.jobs.filter((j) => j.status === "ACCEPTED" || j.status === "IN_PROGRESS").length;
    const completed = w.jobs.filter((j) => j.status === "COMPLETED").length;
    return {
      id: w.id,
      email: w.email,
      name: w.name,
      trade: w.trade,
      status: w.status,
      linked: w.userId != null,
      invitedAt: w.invitedAt.toISOString(),
      acceptedAt: w.acceptedAt ? w.acceptedAt.toISOString() : null,
      stats: { offered, active, completed },
    };
  });
}

export async function inviteWorker(input: {
  email: string;
  name?: string;
  trade?: string;
}): Promise<Result<{ worker: OwnerWorkerDTO; inviteUrl: string; emailSent: boolean }>> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  const email = input.email.trim().toLowerCase();
  if (!isPlausibleEmail(email)) return { ok: false, reason: "Enter a valid email address" };
  if (email === me.user.email.toLowerCase()) return { ok: false, reason: "You can't invite yourself" };
  const emailBudget = await checkUserEmailBudget(me.user.id, "inviteWorker");
  if (!emailBudget.ok) return { ok: false, reason: emailBudget.reason };

  const token = randomBytes(16).toString("hex");
  // Upsert on (owner, email): re-inviting the same person refreshes the token
  // and re-sends, but never duplicates or un-links an already-accepted worker.
  const worker = await db.worker.upsert({
    where: { ownerId_email: { ownerId: me.user.id, email } },
    update: {
      name: input.name?.trim() || undefined,
      trade: input.trade?.trim() || undefined,
      // Only reset an un-accepted invite; keep an active worker active.
      ...(await isPendingInvite(me.user.id, email)
        ? { status: "INVITED", inviteToken: token, invitedAt: new Date() }
        : {}),
    },
    create: {
      ownerId: me.user.id,
      email,
      name: input.name?.trim() || null,
      trade: input.trade?.trim() || null,
      status: "INVITED",
      inviteToken: token,
    },
    include: { jobs: { select: { status: true } } },
  });

  const inviteUrl = `${appBaseUrl()}/worker/join?token=${worker.inviteToken}`;
  const tmpl = renderWorkerInviteEmail({
    ownerName: me.user.name || me.profile.contractorName,
    company: me.profile.company,
    acceptUrl: inviteUrl,
    workerName: worker.name,
  });
  const sent = await sendEmailViaResend({
    to: email,
    fromName: me.profile.company || "GutterScan",
    replyTo: me.user.email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
  });

  revalidatePath("/dashboard/workers");
  return {
    ok: true,
    inviteUrl,
    emailSent: sent.ok,
    worker: {
      id: worker.id,
      email: worker.email,
      name: worker.name,
      trade: worker.trade,
      status: worker.status,
      linked: worker.userId != null,
      invitedAt: worker.invitedAt.toISOString(),
      acceptedAt: worker.acceptedAt ? worker.acceptedAt.toISOString() : null,
      stats: { offered: 0, active: 0, completed: 0 },
    },
  };
}

async function isPendingInvite(ownerId: string, email: string): Promise<boolean> {
  const existing = await db.worker.findUnique({
    where: { ownerId_email: { ownerId, email } },
    select: { status: true, userId: true },
  });
  return !existing || (existing.status === "INVITED" && existing.userId == null);
}

export async function setWorkerStatus(
  workerId: string,
  status: "ACTIVE" | "DISABLED",
): Promise<VoidResult> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  const res = await db.worker.updateMany({
    where: { id: workerId, ownerId: me.user.id },
    data: { status },
  });
  if (res.count === 0) return { ok: false, reason: "Worker not found" };
  revalidatePath("/dashboard/workers");
  return { ok: true };
}

export async function resendWorkerInvite(workerId: string): Promise<Result<{ inviteUrl: string; emailSent: boolean }>> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  const worker = await db.worker.findFirst({ where: { id: workerId, ownerId: me.user.id } });
  if (!worker) return { ok: false, reason: "Worker not found" };
  const emailBudget = await checkUserEmailBudget(me.user.id, "resendWorkerInvite");
  if (!emailBudget.ok) return { ok: false, reason: emailBudget.reason };
  const token = randomBytes(16).toString("hex");
  await db.worker.update({
    where: { id: worker.id },
    data: { inviteToken: token, invitedAt: new Date(), status: worker.userId ? worker.status : "INVITED" },
  });
  const inviteUrl = `${appBaseUrl()}/worker/join?token=${token}`;
  const tmpl = renderWorkerInviteEmail({
    ownerName: me.user.name || me.profile.contractorName,
    company: me.profile.company,
    acceptUrl: inviteUrl,
    workerName: worker.name,
  });
  const sent = await sendEmailViaResend({
    to: worker.email,
    fromName: me.profile.company || "GutterScan",
    replyTo: me.user.email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
  });
  return { ok: true, inviteUrl, emailSent: sent.ok };
}

// ── Assignable proposals (job sources) ──────────────────────────────────────

export async function listAssignableProposals(): Promise<AssignableProposalDTO[]> {
  const me = await getMe();
  if (!me) return [];
  const rows = await db.proposal.findMany({
    where: { userId: me.user.id },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: { id: true, address: true, clientName: true, data: true },
  });
  return rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const jobType = typeof data.jobType === "string" ? data.jobType : null;
    const takeoff = data.takeoff as Record<string, unknown> | undefined;
    const hasRoof = !!takeoff && (Array.isArray(takeoff.eaves) || !!takeoff.roofStructure);
    return { id: r.id, address: r.address, clientName: r.clientName, jobType, hasRoof };
  });
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function assignJob(input: {
  workerId: string;
  proposalId?: string | null;
  title: string;
  address: string;
  clientName?: string | null;
  clientPhone?: string | null;
  kind: JobKind;
  scope?: string | null;
  workerPayCents: number;
  startsAtIso: string;
  endsAtIso: string;
  /** When true, create despite a scheduling overlap warning. */
  ignoreConflict?: boolean;
}): Promise<Result<{ job: OwnerJobDTO; emailSent: boolean }> | { ok: false; reason: string; conflict: true }> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };

  const title = input.title.trim();
  const address = input.address.trim();
  if (!title) return { ok: false, reason: "Job title is required" };
  if (!address) return { ok: false, reason: "Job address is required" };
  const startsAt = new Date(input.startsAtIso);
  const endsAt = new Date(input.endsAtIso);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()))
    return { ok: false, reason: "Invalid schedule dates" };
  if (endsAt <= startsAt) return { ok: false, reason: "End time must be after the start time" };
  if (!Number.isFinite(input.workerPayCents) || input.workerPayCents < 0)
    return { ok: false, reason: "Enter a valid worker pay" };

  // Ownership: the worker must belong to this owner and not be disabled.
  const worker = await db.worker.findFirst({
    where: { id: input.workerId, ownerId: me.user.id },
  });
  if (!worker) return { ok: false, reason: "Worker not found" };
  if (worker.status === "DISABLED") return { ok: false, reason: "That worker is disabled" };

  // Ownership + redacted snapshot from the proposal (if any).
  let roofSnapshot: ReturnType<typeof buildWorkerRoofSnapshot> = null;
  let proposalId: string | null = null;
  if (input.proposalId) {
    const proposal = await db.proposal.findFirst({
      where: { id: input.proposalId, userId: me.user.id },
      select: { id: true, data: true },
    });
    if (!proposal) return { ok: false, reason: "Proposal not found" };
    proposalId = proposal.id;
    roofSnapshot = buildWorkerRoofSnapshot(proposal.data);
  }

  // Smart conflict check: warn (don't block) if this worker already has an
  // overlapping OFFERED/ACCEPTED/IN_PROGRESS job.
  if (!input.ignoreConflict) {
    const clash = await db.jobAssignment.findFirst({
      where: {
        workerId: worker.id,
        status: { in: ACTIVE_JOB_STATUSES },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { title: true, startsAt: true },
    });
    if (clash) {
      return {
        ok: false,
        conflict: true,
        reason: `${worker.name || worker.email} already has "${clash.title}" that overlaps this time. Assign anyway?`,
      };
    }
  }

  const job = await db.jobAssignment.create({
    data: {
      ownerId: me.user.id,
      workerId: worker.id,
      proposalId,
      title,
      address,
      clientName: input.clientName?.trim() || null,
      clientPhone: input.clientPhone?.trim() || null,
      kind: input.kind,
      scope: input.scope?.trim() || null,
      workerPayCents: Math.round(input.workerPayCents),
      roofSnapshot: roofSnapshot ? (roofSnapshot as object) : undefined,
      startsAt,
      endsAt,
      status: "OFFERED",
    },
  });

  // Best-effort notify the worker (the job exists regardless of email).
  let emailSent = false;
  const when = startsAt.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const sent = await sendEmailViaResend({
    to: worker.email,
    fromName: me.profile.company || "GutterScan",
    replyTo: me.user.email,
    ...renderJobOfferEmail({
      company: me.profile.company || "Your contractor",
      jobTitle: title,
      address,
      when,
      portalUrl: `${appBaseUrl()}/worker/jobs/${job.id}`,
    }),
  });
  emailSent = sent.ok;

  revalidatePath("/dashboard/workers");
  revalidatePath("/dashboard/calendar");
  return {
    ok: true,
    emailSent,
    job: {
      id: job.id,
      workerId: worker.id,
      workerName: worker.name || worker.email,
      workerStatus: worker.status,
      status: job.status,
      title: job.title,
      address: job.address,
      clientName: job.clientName,
      kind: job.kind,
      kindLabel: JOB_KIND_LABEL[job.kind],
      scope: job.scope,
      workerPayCents: job.workerPayCents,
      startsAt: job.startsAt.toISOString(),
      endsAt: job.endsAt.toISOString(),
      declineReason: job.declineReason,
      proposalId: job.proposalId,
      createdAt: job.createdAt.toISOString(),
    },
  };
}

export async function listOwnerJobs(): Promise<OwnerJobDTO[]> {
  const me = await getMe();
  if (!me) return [];
  const jobs = await db.jobAssignment.findMany({
    where: { ownerId: me.user.id },
    orderBy: { startsAt: "desc" },
    take: 200,
    include: { worker: { select: { name: true, email: true, status: true } } },
  });
  return jobs.map((j) => ({
    id: j.id,
    workerId: j.workerId,
    workerName: j.worker.name || j.worker.email,
    workerStatus: j.worker.status,
    status: j.status,
    title: j.title,
    address: j.address,
    clientName: j.clientName,
    kind: j.kind,
    kindLabel: JOB_KIND_LABEL[j.kind],
    scope: j.scope,
    workerPayCents: j.workerPayCents,
    startsAt: j.startsAt.toISOString(),
    endsAt: j.endsAt.toISOString(),
    declineReason: j.declineReason,
    proposalId: j.proposalId,
    createdAt: j.createdAt.toISOString(),
  }));
}

/** Slim event for the owner's week calendar — assigned jobs overlay. */
export type JobCalendarEventDTO = {
  id: string;
  title: string;
  address: string;
  workerId: string;
  workerName: string;
  status: JobAssignmentStatus;
  kindLabel: string;
  workerPayCents: number;
  startsAt: string;
  endsAt: string;
};

export async function listJobCalendarEvents(
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<JobCalendarEventDTO[]> {
  const me = await getMe();
  if (!me) return [];
  const rangeStart = new Date(rangeStartIso);
  const rangeEnd = new Date(rangeEndIso);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) return [];
  const jobs = await db.jobAssignment.findMany({
    where: {
      ownerId: me.user.id,
      status: { not: "CANCELLED" },
      startsAt: { lt: rangeEnd },
      endsAt: { gt: rangeStart },
    },
    orderBy: { startsAt: "asc" },
    include: { worker: { select: { name: true, email: true } } },
  });
  return jobs.map((j) => ({
    id: j.id,
    title: j.title,
    address: j.address,
    workerId: j.workerId,
    workerName: j.worker.name || j.worker.email,
    status: j.status,
    kindLabel: JOB_KIND_LABEL[j.kind],
    workerPayCents: j.workerPayCents,
    startsAt: j.startsAt.toISOString(),
    endsAt: j.endsAt.toISOString(),
  }));
}

/** Recent worker responses (accepted / declined / completed) for the owner's
 *  notification bell. Newest first. */
export type WorkerActivityDTO = {
  id: string;
  jobId: string;
  jobTitle: string;
  workerName: string;
  event: "ACCEPTED" | "DECLINED" | "COMPLETED";
  declineReason: string | null;
  at: string;
};

export async function listWorkerActivity(): Promise<WorkerActivityDTO[]> {
  const me = await getMe();
  if (!me) return [];
  const since = new Date(Date.now() - 14 * 24 * 3600_000);
  const jobs = await db.jobAssignment.findMany({
    where: {
      ownerId: me.user.id,
      OR: [
        { respondedAt: { gte: since }, status: { in: ["ACCEPTED", "DECLINED", "IN_PROGRESS"] } },
        { completedAt: { gte: since }, status: "COMPLETED" },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 12,
    include: { worker: { select: { name: true, email: true } } },
  });
  return jobs.map((j) => {
    const completed = j.status === "COMPLETED";
    const at = (completed ? j.completedAt : j.respondedAt) ?? j.updatedAt;
    return {
      id: `${j.id}:${j.status}`,
      jobId: j.id,
      jobTitle: j.title,
      workerName: j.worker.name || j.worker.email,
      event: completed ? "COMPLETED" : j.status === "DECLINED" ? "DECLINED" : "ACCEPTED",
      declineReason: j.status === "DECLINED" ? j.declineReason : null,
      at: at.toISOString(),
    };
  });
}

export async function cancelJob(jobId: string): Promise<VoidResult> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  const res = await db.jobAssignment.updateMany({
    where: { id: jobId, ownerId: me.user.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  if (res.count === 0) return { ok: false, reason: "Job can't be cancelled" };
  revalidatePath("/dashboard/workers");
  revalidatePath("/dashboard/calendar");
  return { ok: true };
}
