"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runAIEstimatePipeline, type EstimateResult } from "@/lib/ai";
import { blueprintToEstimateResult } from "@/lib/ai/blueprint-to-estimate";
import type { BlueprintAnalysis } from "@/lib/ai/blueprint-from-plans";
import { getMe } from "./me";

export type RunEstimateResponse =
  | {
      ok: true;
      result: EstimateResult;
      reused: boolean;
      remaining: number;
      runId: string;
    }
  | {
      ok: false;
      reason: string;
      remaining: number;
    };

const TWENTY_FOUR_HOURS = 24 * 3600 * 1000;
const SAME_ADDRESS_DAILY_LIMIT = 10;

export async function runEstimate(
  address: string,
): Promise<RunEstimateResponse> {
  const trimmed = address.trim();
  if (!trimmed) {
    return { ok: false, reason: "Address is required", remaining: 0 };
  }

  // Wrap session lookup so a transient DB / Clerk failure surfaces as a
  // readable reason string instead of throwing past the page boundary.
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch (e) {
    console.error("[runEstimate] getMe failed", e);
    const msg = e instanceof Error ? e.message : "Session lookup failed";
    return { ok: false, reason: msg, remaining: 0 };
  }
  if (!me) {
    return { ok: false, reason: "Not signed in", remaining: 0 };
  }

  const userId = me.user.id;
  const norm = trimmed.toLowerCase();
  const since = new Date(Date.now() - TWENTY_FOUR_HOURS);

  const totalCredits = me.credits.included + me.credits.bonus;
  const remainingBefore = Math.max(totalCredits - me.credits.used, 0);

  const recentSame = await db.estimateRun.count({
    where: { userId, addressNormalized: norm, createdAt: { gte: since } },
  });

  if (recentSame >= SAME_ADDRESS_DAILY_LIMIT) {
    return {
      ok: false,
      reason: `This address has been re-run ${SAME_ADDRESS_DAILY_LIMIT} times in the last 24 hours.`,
      remaining: remainingBefore,
    };
  }

  const isReused = recentSame > 0;
  if (!isReused && remainingBefore <= 0) {
    return {
      ok: false,
      reason: "Out of credits — top up or wait until your next renewal.",
      remaining: 0,
    };
  }

  let result: EstimateResult;
  try {
    result = await runAIEstimatePipeline(trimmed);
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI pipeline failed";
    await db.estimateRun.create({
      data: {
        userId,
        address: trimmed,
        addressNormalized: norm,
        status: "FAILED",
        creditConsumed: false,
        reused: isReused,
        errorMessage: message,
      },
    });
    return { ok: false, reason: message, remaining: remainingBefore };
  }

  const writes: Prisma.PrismaPromise<unknown>[] = [
    db.estimateRun.create({
      data: {
        userId,
        address: result.geocoded.formatted,
        addressNormalized: norm,
        status: "SUCCEEDED",
        creditConsumed: !isReused,
        reused: isReused,
        durationMs: result.durationMs,
        measurements: result.measurements as unknown as Prisma.InputJsonValue,
      },
    }),
  ];
  if (!isReused) {
    writes.push(
      db.creditWallet.update({
        where: { userId },
        data: { used: { increment: 1 } },
      }),
    );
  }
  const [created] = (await db.$transaction(writes)) as [{ id: string }];

  const remainingAfter = isReused
    ? remainingBefore
    : Math.max(remainingBefore - 1, 0);

  return {
    ok: true,
    result,
    reused: isReused,
    remaining: remainingAfter,
    runId: created.id,
  };
}

/**
 * Loads a saved PlanAnalysis (from /dashboard/blueprints upload) and
 * projects it into the same EstimateResult shape /estimate normally
 * gets from the address pipeline. Lets the contractor edit/save/send
 * a proposal from a plan exactly the way they would from a satellite-
 * derived estimate.
 *
 * No credit consumed — the blueprint pipeline is free per product call.
 */
export async function runEstimateFromPlan(
  planId: string,
): Promise<RunEstimateResponse> {
  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe();
  } catch (e) {
    console.error("[runEstimateFromPlan] getMe failed", e);
    const msg = e instanceof Error ? e.message : "Session lookup failed";
    return { ok: false, reason: msg, remaining: 0 };
  }
  if (!me) return { ok: false, reason: "Not signed in", remaining: 0 };

  const totalCredits = me.credits.included + me.credits.bonus;
  const remaining = Math.max(totalCredits - me.credits.used, 0);

  const row = await db.planAnalysis.findFirst({
    where: { id: planId, userId: me.user.id },
  });
  if (!row) {
    return { ok: false, reason: "Plan analysis not found", remaining };
  }
  if (row.status !== "SUCCEEDED" || !row.analysisJson) {
    return {
      ok: false,
      reason:
        row.status === "FAILED"
          ? row.errorMessage ?? "Plan analysis failed"
          : "Plan analysis is still in progress",
      remaining,
    };
  }

  const analysis = row.analysisJson as unknown as BlueprintAnalysis;
  const result = blueprintToEstimateResult(analysis, {
    filename: row.filename,
    durationMs: row.durationMs ?? undefined,
  });

  return {
    ok: true,
    result,
    reused: true, // not chargeable; surface as "reused" in the UI badge
    remaining,
    runId: row.id,
  };
}
