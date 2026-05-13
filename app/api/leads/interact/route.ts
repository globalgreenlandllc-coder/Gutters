import { NextResponse } from "next/server";
import { PrismaClient, InteractionStatus } from "@prisma/client";
import { auth } from "@clerk/nextjs/server";

const prisma = new PrismaClient();

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { leadId, status, notes } = await request.json();

    if (!leadId || !status) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) {
      return NextResponse.json({ error: "User not found in DB" }, { status: 404 });
    }

    // Upsert the interaction
    const interaction = await prisma.userLeadInteraction.upsert({
      where: {
        userId_leadId: {
          userId: user.id,
          leadId: leadId,
        },
      },
      update: {
        status: status as InteractionStatus,
        ...(notes !== undefined && { notes }),
        updatedAt: new Date(),
      },
      create: {
        userId: user.id,
        leadId: leadId,
        status: status as InteractionStatus,
        ...(notes !== undefined && { notes }),
      },
    });

    return NextResponse.json({ success: true, interaction });
  } catch (error: any) {
    console.error("[POST /api/leads/interact] Error:", error);
    return NextResponse.json({ error: "Failed to save interaction" }, { status: 500 });
  }
}
