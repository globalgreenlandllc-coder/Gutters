import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { auth } from "@clerk/nextjs/server";

const prisma = new PrismaClient();

export async function GET(request: Request) {
  const { userId: clerkId } = await auth();

  const url = new URL(request.url);
  const bbox = url.searchParams.get("bbox"); // "west,south,east,north"
  const trade = url.searchParams.get("trade");
  const status = url.searchParams.get("status");

  try {
    let whereClause: any = {};

    // 1. Filter by Bounding Box (bbox)
    if (bbox) {
      const [west, south, east, north] = bbox.split(",").map(Number);
      if (!isNaN(west) && !isNaN(south) && !isNaN(east) && !isNaN(north)) {
        whereClause.latitude = { gte: south, lte: north };
        whereClause.longitude = { gte: west, lte: east };
      }
    }

    // 2. Filter by Trade and Status
    if (trade && trade !== "All") {
      whereClause.categorizedTrade = trade;
    }
    if (status && status !== "All") {
      whereClause.status = status;
    }

    // 3. Fetch leads
    const leads = await prisma.lead.findMany({
      where: whereClause,
      take: 200, // Limit to 200 leads on map to avoid freezing
    });

    // 4. If user is logged in, attach their CRM interactions
    if (clerkId) {
      const user = await prisma.user.findUnique({ where: { clerkId } });
      if (user) {
        const interactions = await prisma.userLeadInteraction.findMany({
          where: {
            userId: user.id,
            leadId: { in: leads.map((l) => l.id) },
          },
        });

        const interactionMap = new Map();
        interactions.forEach((i) => interactionMap.set(i.leadId, i));

        const leadsWithInteractions = leads.map((l) => ({
          ...l,
          interaction: interactionMap.get(l.id) || null,
        }));

        return NextResponse.json(leadsWithInteractions);
      }
    }

    // Return without interactions if not logged in
    return NextResponse.json(leads);
  } catch (error: any) {
    console.error("[GET /api/leads] Error:", error);
    return NextResponse.json({ error: "Failed to fetch leads" }, { status: 500 });
  }
}
