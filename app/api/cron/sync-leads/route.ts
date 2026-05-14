import { NextResponse } from "next/server";
import { LeadStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { getActiveApiKey } from "@/lib/api-keys";
import { fetchSocrataPermits, RawPermitData } from "@/lib/leads/adapters/socrata";
import { fetchArcgisPermits } from "@/lib/leads/adapters/arcgis";
import { cityRegistry } from "@/lib/leads/adapters/cities";
import { analyzePermit } from "@/lib/leads/ai-normalizer";

const AI_CONCURRENCY = 5;

function mapStatusToEnum(rawStatus: string): LeadStatus {
  const s = rawStatus.toUpperCase();
  if (s.includes("APPL")) return LeadStatus.APPLIED;
  if (s.includes("REVIEW")) return LeadStatus.UNDER_REVIEW;
  if (s.includes("ISSUE")) return LeadStatus.ISSUED;
  if (s.includes("INSPECT")) return LeadStatus.INSPECTION;
  if (s.includes("FINAL") || s.includes("CLOSE")) return LeadStatus.FINALED;
  return LeadStatus.UNKNOWN;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function syncPermits(rawPermits: RawPermitData[]) {
  if (rawPermits.length === 0) return { added: 0, updated: 0 };

  const existing = await db.lead.findMany({
    where: {
      OR: rawPermits.map((p) => ({
        sourceCity: p.sourceCity,
        sourceId: p.sourceId,
      })),
    },
    select: {
      id: true,
      sourceId: true,
      sourceCity: true,
      status: true,
      originalDescription: true,
      buildingType: true,
      projectKind: true,
      contractorName: true,
      aiSummary: true,
      aiRelevance: true,
    },
  });
  const existingMap = new Map(existing.map((e) => [`${e.sourceCity}:${e.sourceId}`, e]));

  const newPermits: RawPermitData[] = [];
  // Backfill payload for existing rows that are missing any of the smarter fields.
  const backfillTargets: Array<{
    permit: RawPermitData;
    existing: (typeof existing)[number];
    mappedStatus: LeadStatus;
  }> = [];

  for (const permit of rawPermits) {
    const key = `${permit.sourceCity}:${permit.sourceId}`;
    const exist = existingMap.get(key);
    const mappedStatus = mapStatusToEnum(permit.status);
    if (exist) {
      // "Stale" buildingType: earlier adapter versions stored either the
      // mapped bucket ("Residential"/"Non-Residential") or Tacoma's
      // permit-category text ("Building", "Right-of-Way", etc.) instead of
      // the real building class. Replace those when we have a fresh value.
      const STALE_BUILDING_TYPES = new Set([
        "Residential",
        "Non-Residential",
        "Building",
        "Right-of-Way",
        "ePermit",
        "Utility Connection",
        "Site",
        "Sign",
      ]);
      const buildingTypeIsStale =
        permit.buildingType != null &&
        permit.buildingType !== exist.buildingType &&
        (exist.buildingType == null || STALE_BUILDING_TYPES.has(exist.buildingType));

      // projectKind is stale if currently "Other" but the new value is one
      // of the canonical specific buckets.
      const projectKindIsStale =
        permit.projectKind != null &&
        permit.projectKind !== "Other" &&
        permit.projectKind !== exist.projectKind &&
        (exist.projectKind == null || exist.projectKind === "Other");

      const needsBackfill =
        exist.status !== mappedStatus ||
        buildingTypeIsStale ||
        projectKindIsStale ||
        (exist.contractorName == null && permit.contractorName != null) ||
        exist.aiSummary == null ||
        exist.aiRelevance == null;
      if (needsBackfill) {
        backfillTargets.push({ permit, existing: exist, mappedStatus });
      }
    } else {
      newPermits.push(permit);
    }
  }

  // For new permits AND existing-but-missing-AI ones, run analyzePermit once.
  const aiTargets = [
    ...newPermits.map((p) => ({ kind: "new" as const, permit: p })),
    ...backfillTargets
      .filter((b) => b.existing.aiSummary == null || b.existing.aiRelevance == null)
      .map((b) => ({ kind: "backfill" as const, permit: b.permit, existing: b.existing })),
  ];
  const aiResults = await mapWithConcurrency(aiTargets, AI_CONCURRENCY, async (t) => ({
    ...t,
    insight: await analyzePermit(t.permit.originalDescription, t.permit.buildingType),
  }));
  const insightByKey = new Map(
    aiResults.map((r) => [`${r.permit.sourceCity}:${r.permit.sourceId}`, r.insight]),
  );

  let addedCount = 0;
  const toCreate = newPermits.map((permit) => {
    const insight = insightByKey.get(`${permit.sourceCity}:${permit.sourceId}`)!;
    return {
      sourceId: permit.sourceId,
      sourceCity: permit.sourceCity,
      address: permit.address,
      originalDescription: permit.originalDescription,
      categorizedTrade: insight.trade,
      aiSummary: insight.summary,
      aiRelevance: insight.relevance,
      buildingType: permit.buildingType ?? null,
      projectKind: permit.projectKind ?? null,
      contractorName: permit.contractorName ?? null,
      status: mapStatusToEnum(permit.status),
      latitude: permit.latitude,
      longitude: permit.longitude,
      projectValue: permit.projectValue,
    };
  });
  if (toCreate.length > 0) {
    const created = await db.lead.createMany({ data: toCreate, skipDuplicates: true });
    addedCount = created.count;
  }

  // Apply backfills serially-batched so we don't fan out hundreds of writes.
  await Promise.all(
    backfillTargets.map(({ permit, existing: ex, mappedStatus }) => {
      const insightKey = `${permit.sourceCity}:${permit.sourceId}`;
      const insight = insightByKey.get(insightKey);
      // Overwrite buildingType if we now have a more specific value (e.g.
      // "Single Family/Duplex" replacing the old broad "Residential").
      const STALE_BUILDING_TYPES = new Set([
        "Residential",
        "Non-Residential",
        "Building",
        "Right-of-Way",
        "ePermit",
        "Utility Connection",
        "Site",
        "Sign",
      ]);
      const shouldUpdateBuildingType =
        permit.buildingType != null &&
        permit.buildingType !== ex.buildingType &&
        (ex.buildingType == null || STALE_BUILDING_TYPES.has(ex.buildingType));

      // Overwrite projectKind when we now have a specific value replacing
      // a null/"Other".
      const shouldUpdateProjectKind =
        permit.projectKind != null &&
        permit.projectKind !== "Other" &&
        permit.projectKind !== ex.projectKind &&
        (ex.projectKind == null || ex.projectKind === "Other");

      return db.lead.update({
        where: { id: ex.id },
        data: {
          status: mappedStatus,
          ...(shouldUpdateBuildingType ? { buildingType: permit.buildingType } : {}),
          ...(shouldUpdateProjectKind ? { projectKind: permit.projectKind } : {}),
          // Only fill nulls for fields that may have been touched/edited.
          ...(ex.contractorName == null && permit.contractorName
            ? { contractorName: permit.contractorName }
            : {}),
          ...(ex.aiSummary == null && insight ? { aiSummary: insight.summary } : {}),
          ...(ex.aiRelevance == null && insight ? { aiRelevance: insight.relevance } : {}),
        },
      });
    }),
  );

  return { added: addedCount, updated: backfillTargets.length };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[Sync Worker] Starting multi-city permit sync...");

    const enabled = cityRegistry.filter((c) => c.enabled);
    const perCity: Array<{ city: string; added: number; updated: number; fetched: number }> = [];

    // One Socrata app token works across every city-data portal. Optional;
    // without it we share the anonymous rate-limit pool.
    const socrataToken = await getActiveApiKey("SOCRATA");

    // Fetch all city feeds in parallel, then sync them serially so DB writes
    // from one city don't race with another's existence check.
    const fetched = await Promise.all(
      enabled.map(async (entry) => ({
        entry,
        permits:
          entry.kind === "arcgis"
            ? await fetchArcgisPermits(entry.dataset, entry.limit)
            : await fetchSocrataPermits(entry.dataset, entry.limit, socrataToken),
      })),
    );

    for (const { entry, permits } of fetched) {
      const { added, updated } = await syncPermits(permits);
      perCity.push({
        city: entry.dataset.city,
        fetched: permits.length,
        added,
        updated,
      });
      console.log(
        `[Sync Worker] ${entry.dataset.city}: fetched=${permits.length}, added=${added}, updated=${updated}`,
      );
    }

    const totalAdded = perCity.reduce((a, c) => a + c.added, 0);
    const totalUpdated = perCity.reduce((a, c) => a + c.updated, 0);

    console.log(
      `[Sync Worker] Complete. Total added=${totalAdded}, updated=${totalUpdated}`,
    );

    return NextResponse.json({
      success: true,
      added: totalAdded,
      updated: totalUpdated,
      cities: perCity,
    });
  } catch (error: any) {
    console.error("[Sync Worker] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
