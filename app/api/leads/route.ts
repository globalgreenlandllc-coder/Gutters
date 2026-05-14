import { NextResponse } from "next/server";
import { Prisma, LeadStatus, InteractionStatus } from "@prisma/client";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

const MAP_LIMIT = 200;

export async function GET(request: Request) {
  const { userId: clerkId } = await auth();

  const url = new URL(request.url);
  const bbox = url.searchParams.get("bbox");
  const trade = url.searchParams.get("trade");
  const status = url.searchParams.get("status");
  const interactionStatus = url.searchParams.get("interactionStatus");
  const buildingType = url.searchParams.get("buildingType");
  const projectKind = url.searchParams.get("projectKind");
  const relevance = url.searchParams.get("relevance");

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
      whereClause.buildingType = buildingType;
    }
    if (projectKind && projectKind !== "All") {
      whereClause.projectKind = projectKind;
    }
    if (relevance && relevance !== "All") {
      whereClause.aiRelevance = relevance;
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

    // Fetch one extra row so we can tell the client when results were truncated.
    const rows = await db.lead.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      take: MAP_LIMIT + 1,
    });

    const hasMore = rows.length > MAP_LIMIT;
    const leads = hasMore ? rows.slice(0, MAP_LIMIT) : rows;

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
