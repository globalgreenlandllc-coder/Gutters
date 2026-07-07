"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getMe } from "@/app/actions/me";
import { toWorkerJobDTO, type WorkerJobDTO } from "@/lib/worker-dto";
import type { JobAssignmentStatus } from "@prisma/client";

/**
 * worker-jobs.ts — WORKER-side actions. Tenancy key is the signed-in user's id;
 * every job query joins through Worker.userId === me.id, so a worker can only
 * ever touch jobs assigned to them. All reads go through toWorkerJobDTO, which
 * carries no owner pricing.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };
type VoidResult = { ok: true } | { ok: false; reason: string };

const JOB_INCLUDE = {
  owner: { select: { name: true, contractorProfile: { select: { company: true } } } },
} as const;

/**
 * Link the signed-in account to the Worker row named by the invite token, and
 * promote the user to the WORKER role. The token is the proof of invitation
 * (like a proposal share link). Idempotent — re-accepting your own invite is a
 * no-op; a token already claimed by someone else is rejected.
 */
export async function acceptWorkerInvite(token: string): Promise<Result<{ alreadyLinked: boolean }>> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Please sign in to accept the invite" };
  const clean = (token ?? "").trim();
  if (!clean) return { ok: false, reason: "Missing invite token" };

  const worker = await db.worker.findUnique({ where: { inviteToken: clean } });
  if (!worker) return { ok: false, reason: "This invite link is invalid or was withdrawn" };
  if (worker.ownerId === me.user.id) return { ok: false, reason: "You can't be your own worker" };

  if (worker.userId && worker.userId !== me.user.id) {
    return { ok: false, reason: "This invite was already claimed by another account" };
  }
  if (worker.userId === me.user.id && worker.status === "ACTIVE") {
    return { ok: true, alreadyLinked: true };
  }

  await db.$transaction([
    db.worker.update({
      where: { id: worker.id },
      data: { userId: me.user.id, status: "ACTIVE", acceptedAt: new Date() },
    }),
    // Promote to WORKER unless they're an admin (admin is env-driven & wins).
    ...(me.user.role === "SUPER_ADMIN"
      ? []
      : [db.user.update({ where: { id: me.user.id }, data: { role: "WORKER" } })]),
  ]);

  revalidatePath("/worker");
  return { ok: true, alreadyLinked: false };
}

export async function listMyJobs(): Promise<WorkerJobDTO[]> {
  const me = await getMe();
  if (!me) return [];
  const jobs = await db.jobAssignment.findMany({
    where: { worker: { userId: me.user.id } },
    orderBy: { startsAt: "desc" },
    take: 200,
    include: JOB_INCLUDE,
  });
  return jobs.map(toWorkerJobDTO);
}

export async function getMyJob(jobId: string): Promise<WorkerJobDTO | null> {
  const me = await getMe();
  if (!me) return null;
  const job = await db.jobAssignment.findFirst({
    where: { id: jobId, worker: { userId: me.user.id } },
    include: JOB_INCLUDE,
  });
  return job ? toWorkerJobDTO(job) : null;
}

export async function respondToJob(
  jobId: string,
  response: "accept" | "decline",
  declineReason?: string,
): Promise<Result<{ status: JobAssignmentStatus }>> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  // Only the assigned worker can respond, and only to an OFFERED job.
  const job = await db.jobAssignment.findFirst({
    where: { id: jobId, worker: { userId: me.user.id }, status: "OFFERED" },
    select: { id: true },
  });
  if (!job) return { ok: false, reason: "This job is no longer open to respond to" };

  const status: JobAssignmentStatus = response === "accept" ? "ACCEPTED" : "DECLINED";
  await db.jobAssignment.update({
    where: { id: job.id },
    data: {
      status,
      respondedAt: new Date(),
      declineReason: response === "decline" ? (declineReason?.trim() || null) : null,
    },
  });
  revalidatePath("/worker");
  revalidatePath(`/worker/jobs/${jobId}`);
  return { ok: true, status };
}

export async function markJobComplete(jobId: string): Promise<VoidResult> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  const res = await db.jobAssignment.updateMany({
    where: { id: jobId, worker: { userId: me.user.id }, status: { in: ["ACCEPTED", "IN_PROGRESS"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (res.count === 0) return { ok: false, reason: "This job can't be marked complete" };
  revalidatePath("/worker");
  revalidatePath(`/worker/jobs/${jobId}`);
  return { ok: true };
}
