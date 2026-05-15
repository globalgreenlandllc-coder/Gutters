import { NextResponse } from "next/server";
import { Prisma, LeadStatus, InteractionStatus } from "@prisma/client";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

const MAP_LIMIT = 500;

export async function GET(request: Request) {
  const { userId: clerkId } = await auth();

  const url = new URL(request.url);
  const bbox = url.searchParams.get("bbox");
  const trade = url.searchParams.get("trade");
  const status = url.searchParams.get("status");
  const interactionStatus = url.searchParams.get("interactionStatus");
  const buildingType = url.searchParams.get("buildingType");
  const projectKind = url.searchParams.get("projectKind");
  const developmentType = url.searchParams.get("developmentType");
  const relevance = url.searchParams.get("relevance");
  const minUnits = url.searchParams.get("minUnits");
  // Issue-date range in days-ago. Caller passes either:
  //   ?stage=<preset>  — convenient (see STAGE_RANGES below)
  //   ?issuedAfter=<ISO>&issuedBefore=<ISO>  — explicit
  // Default behavior is "active" (last 12 months), so old/finished
  // permits don't dominate the map. Pass stage=all to opt out.
  const stage = url.searchParams.get("stage") ?? "last-12-months";
  const issuedAfterParam = url.searchParams.get("issuedAfter");
  const issuedBeforeParam = url.searchParams.get("issuedBefore");

  try {
    const whereClause: Prisma.LeadWhereInput = {};

    if (bbox) {
      const [west, south, east, north] = bbox.split(",").map(Number);
      if (!isNaN(west) && !isNaN(south) && !isNaN(east) && !isNaN(north)) {
        whereClause.latitude = { gte: south, lte: north };
        whereClause.longitude = { gte: west, lte: east };
      }
    }

    if (trade && trade !== "All") {
      whereClause.categorizedTrade = trade;
    }
    if (status && status !== "All" && status in LeadStatus) {
      whereClause.status = status as LeadStatus;
    }
    if (buildingType && buildingType !== "All") {
      // "Residential" is treated as an umbrella that matches any residential
      // class regardless of city-specific labels (Seattle / Bellevue use
      // "Single Family/Duplex" + "Multifamily"; Pierce / Tacoma use the
      // broader "Residential" string).
      if (buildingType === "Residential") {
        whereClause.buildingType = {
          in: [
            "Residential",
            "Single Family/Duplex",
            "Single Family Condo Unit",
            "Multifamily",
            "Multifamily Residential",
            "Single Family Residential",
          ],
        };
      } else {
        whereClause.buildingType = buildingType;
      }
    }
    if (projectKind && projectKind !== "All") {
      whereClause.projectKind = projectKind;
    }
    if (developmentType && developmentType !== "All") {
      whereClause.developmentType = developmentType;
    }
    if (minUnits) {
      const n = parseInt(minUnits, 10);
      if (!isNaN(n) && n > 0) {
        whereClause.housingUnits = { gte: n };
      }
    }
    if (relevance && relevance !== "All") {
      whereClause.aiRelevance = relevance;
    }

    // Stage / issued-date filter. Preset → (minDaysAgo, maxDaysAgo).
    // maxDaysAgo=Infinity means "no upper bound" (anything older than the
    // minDaysAgo cutoff).
    const STAGE_RANGES: Record<string, { min: number; max: number } | null> = {
      "all": null,
      "last-30-days": { min: 0, max: 30 },
      "30-90-days": { min: 30, max: 90 },
      "90-180-days": { min: 90, max: 180 },
      "180-365-days": { min: 180, max: 365 },
      "last-12-months": { min: 0, max: 365 },
      "older-than-12-months": { min: 365, max: Infinity },
    };

    const daysToDate = (days: number): Date =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let issuedGte: Date | undefined;
    let issuedLte: Date | undefined;

    // Explicit params override the preset.
    if (issuedAfterParam) {
      const d = new Date(issuedAfterParam);
      if (!isNaN(d.getTime())) issuedGte = d;
    }
    if (issuedBeforeParam) {
      const d = new Date(issuedBeforeParam);
      if (!isNaN(d.getTime())) issuedLte = d;
    }
    if (!issuedGte && !issuedLte) {
      const range = STAGE_RANGES[stage];
      if (range) {
        issuedLte = daysToDate(range.min); // newer cutoff
        if (range.max !== Infinity) issuedGte = daysToDate(range.max); // older cutoff
      }
    }
    if (issuedGte || issuedLte) {
      whereClause.issuedDate = {
        ...(issuedGte ? { gte: issuedGte } : {}),
        ...(issuedLte ? { lte: issuedLte } : {}),
      };
    }

    // Interaction filter requires an authenticated user — silently ignore otherwise.
    let internalUserId: string | null = null;
    if (clerkId) {
      const user = await db.user.findUnique({
        where: { clerkId },
        select: { id: true },
      });
      internalUserId = user?.id ?? null;
    }

    if (
      internalUserId &&
      interactionStatus &&
      interactionStatus !== "All" &&
      interactionStatus in InteractionStatus
    ) {
      if (interactionStatus === InteractionStatus.UNREAD) {
        // "Unread" means either no interaction row exists OR the row is explicitly UNREAD.
        whereClause.OR = [
          { NOT: { interactions: { some: { userId: internalUserId } } } },
          {
            interactions: {
              some: { userId: internalUserId, status: InteractionStatus.UNREAD },
            },
          },
        ];
      } else {
        whereClause.interactions = {
          some: {
            userId: internalUserId,
            status: interactionStatus as InteractionStatus,
          },
        };
      }
    }

    // Surface hot leads first, then warm, then cold/null — within each band
    // sort by recency. Without this, a single just-synced city saturates the
    // result and the user sees no pins outside its geographic cluster.
    // Three queries because Prisma can't express "high before medium before
    // low" alphabetically; this is cheaper than a single oversized fetch+
    // JS sort once the bbox contains many thousand leads.
    const remainingAfter = (consumed: number) => Math.max(0, MAP_LIMIT + 1 - consumed);
    const hot = await db.lead.findMany({
      where: { ...whereClause, aiRelevance: "high" },
      orderBy: { createdAt: "desc" },
      take: MAP_LIMIT + 1,
    });
    const warm =
      remainingAfter(hot.length) > 0
        ? await db.lead.findMany({
            where: { ...whereClause, aiRelevance: "medium" },
            orderBy: { createdAt: "desc" },
            take: remainingAfter(hot.length),
          })
        : [];
    const cold =
      remainingAfter(hot.length + warm.length) > 0
        ? await db.lead.findMany({
            where: {
              ...whereClause,
              OR: [{ aiRelevance: "low" }, { aiRelevance: null }],
            },
            orderBy: { createdAt: "desc" },
            take: remainingAfter(hot.length + warm.length),
          })
        : [];

    const combined = [...hot, ...warm, ...cold];
    const hasMore = combined.length > MAP_LIMIT;
    const leads = hasMore ? combined.slice(0, MAP_LIMIT) : combined;

    if (internalUserId) {
      const interactions = await db.userLeadInteraction.findMany({
        where: {
          userId: internalUserId,
          leadId: { in: leads.map((l) => l.id) },
        },
        select: { leadId: true, status: true, notes: true },
      });

      const interactionMap = new Map(interactions.map((i) => [i.leadId, i]));

      const leadsWithInteractions = leads.map((l) => ({
        ...l,
        interaction: interactionMap.get(l.id) ?? null,
      }));

      return NextResponse.json({ leads: leadsWithInteractions, hasMore });
    }

    return NextResponse.json({ leads, hasMore });
  } catch (error: any) {
    console.error("[GET /api/leads] Error:", error);
    return NextResponse.json({ error: "Failed to fetch leads" }, { status: 500 });
  }
}
