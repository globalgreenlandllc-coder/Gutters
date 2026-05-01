"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runAIEstimatePipeline, type EstimateResult } from "@/lib/ai";
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

  const me = await getMe();
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
