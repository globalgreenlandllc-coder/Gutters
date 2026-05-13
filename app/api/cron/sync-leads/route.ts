import { NextResponse } from "next/server";
import { PrismaClient, LeadStatus } from "@prisma/client";
import { fetchSocrataPermits } from "../../../../lib/leads/adapters/socrata";
import { normalizePermitDescription } from "../../../../lib/leads/ai-normalizer";

const prisma = new PrismaClient();

// Helper to map generic string statuses to our Enum
function mapStatusToEnum(rawStatus: string): LeadStatus {
  const s = rawStatus.toUpperCase();
  if (s.includes("APPL")) return LeadStatus.APPLIED;
  if (s.includes("REVIEW")) return LeadStatus.UNDER_REVIEW;
  if (s.includes("ISSUE")) return LeadStatus.ISSUED;
  if (s.includes("INSPECT")) return LeadStatus.INSPECTION;
  if (s.includes("FINAL") || s.includes("CLOSE")) return LeadStatus.FINALED;
  return LeadStatus.UNKNOWN;
}

export async function GET(request: Request) {
  // Protect the route using a CRON_SECRET or an Authorization header
  // In production, Vercel cron jobs pass a Bearer token automatically
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[Sync Worker] Starting permit sync...");

    // 1. Fetch raw permits from our Adapters
    // In the future, you could loop through an array of adapters here.
    const rawPermits = await fetchSocrataPermits(20); // Limit to 20 for this test run
    
    let newLeadsCount = 0;
    let updatedLeadsCount = 0;

    // 2. Process each permit
    for (const permit of rawPermits) {
      // Find if we already have it
      const existing = await prisma.lead.findUnique({
        where: {
          sourceCity_sourceId: {
            sourceCity: permit.sourceCity,
            sourceId: permit.sourceId,
          },
        },
      });

      const mappedStatus = mapStatusToEnum(permit.status);

      if (existing) {
        // Update if status changed
        if (existing.status !== mappedStatus) {
          await prisma.lead.update({
            where: { id: existing.id },
            data: { status: mappedStatus, updatedAt: new Date() },
          });
          updatedLeadsCount++;
        }
      } else {
        // "Smart" step: Run AI Normalization on the description
        const categorizedTrade = await normalizePermitDescription(permit.originalDescription);
        
        await prisma.lead.create({
          data: {
            sourceId: permit.sourceId,
            sourceCity: permit.sourceCity,
            address: permit.address,
            originalDescription: permit.originalDescription,
            categorizedTrade,
            status: mappedStatus,
            latitude: permit.latitude,
            longitude: permit.longitude,
            projectValue: permit.projectValue,
          },
        });
        newLeadsCount++;
      }
    }

    console.log(`[Sync Worker] Complete. Added: ${newLeadsCount}, Updated: ${updatedLeadsCount}`);

    return NextResponse.json({
      success: true,
      added: newLeadsCount,
      updated: updatedLeadsCount,
    });
  } catch (error: any) {
    console.error("[Sync Worker] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
