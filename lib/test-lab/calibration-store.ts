import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { computeLabCalibration, type LabCalibration } from "./lab-calibration";

/**
 * calibration-store.ts — persistence for the accuracy lab's LENGTH-BIAS
 * RADAR: the median LF delta computed from the admin's corrections,
 * refreshed on every finalize and displayed in the lab.
 *
 * DELIBERATELY SIGNAL-ONLY. An auto-applied geometric lever was built,
 * probed, and removed: offsetting the drip-edge ring is a cliff, not a
 * dial — on the Lake Stevens reference roof, +0.02 m did nothing while
 * +0.04 m flipped two gable edges into eaves (+36 LF, +13%). A knob that
 * can silently swing quotes double-digits on some roofs must not touch
 * user scans; the bias number instead directs deterministic engine
 * fixes, which land with replay-scored proof.
 */

const SETTING_KEY = "testlab.calibration";

export type LabCalibrationSetting = {
  computed: LabCalibration | null;
  computedAt: string | null;
};

const EMPTY: LabCalibrationSetting = { computed: null, computedAt: null };

export async function readLabCalibrationSetting(): Promise<LabCalibrationSetting> {
  try {
    const row = await db.platformSetting.findUnique({ where: { key: SETTING_KEY } });
    if (!row) return EMPTY;
    const v = row.value as Partial<LabCalibrationSetting> | null;
    return {
      computed: v?.computed ?? null,
      computedAt: v?.computedAt ?? null,
    };
  } catch (e) {
    console.warn("[test-lab] calibration read failed:", e);
    return EMPTY;
  }
}

/** Recompute the bias radar from recent finalized lab runs and store it.
 *  Called after each finalize; never throws. */
export async function recomputeLabCalibration(updatedBy?: string): Promise<LabCalibration | null> {
  try {
    const rows = await db.testLabRun.findMany({
      where: { status: { in: ["APPROVED", "CORRECTED"] } },
      select: { status: true, diffJson: true },
      orderBy: { createdAt: "desc" },
      take: 40, // recency window — old eras shouldn't outvote current behavior
    });
    const inputs = rows.flatMap((r) => {
      const d = r.diffJson as { eaveLFBefore?: number; eaveLFAfter?: number } | null;
      if (!d || typeof d.eaveLFBefore !== "number" || typeof d.eaveLFAfter !== "number") return [];
      return [
        {
          status: r.status as "APPROVED" | "CORRECTED",
          eaveLFBefore: d.eaveLFBefore,
          eaveLFAfter: d.eaveLFAfter,
        },
      ];
    });
    const computed = computeLabCalibration(inputs);
    const next: LabCalibrationSetting = {
      computed,
      computedAt: new Date().toISOString(),
    };
    await db.platformSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: next as unknown as Prisma.InputJsonValue, updatedBy },
      update: { value: next as unknown as Prisma.InputJsonValue, updatedBy },
    });
    return computed;
  } catch (e) {
    console.warn("[test-lab] calibration recompute failed:", e);
    return null;
  }
}
