import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  blueprintFromPlanSources,
  type PlanSource,
} from "@/lib/ai/blueprint-from-plans";

// Vision-on-plans takes 30-60s. Bump above the default 10s.
export const maxDuration = 90;

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
      { status: 413 },
    );
  }

  const arrayBuf = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const base64 = buffer.toString("base64");
  const mime = file.type || "application/octet-stream";
  const isPdf =
    mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = mime.startsWith("image/");
  if (!isPdf && !isImage) {
    return NextResponse.json(
      { error: "Only PDF and image files are supported" },
      { status: 415 },
    );
  }

  // Create the analysis row in QUEUED state so the user can poll for it
  // (and we have a record even if the AI call later fails).
  const analysis = await db.planAnalysis.create({
    data: {
      userId: user.id,
      filename: file.name,
      mimeType: mime,
      originalData: base64,
      // For PDFs we no longer pre-rasterize — Claude handles paging
      // natively. For images we keep the single page as a preview source
      // for the result-page background overlay.
      pageImages: isPdf
        ? Prisma.JsonNull
        : [
            {
              pageIndex: 1,
              base64,
              mediaType: mime,
            },
          ],
      pageCount: isPdf ? null : 1,
      status: "QUEUED",
    },
  });

  try {
    const source: PlanSource = isPdf
      ? { kind: "pdf", base64 }
      : {
          kind: "image",
          base64,
          mediaType: (mime === "image/png" ||
          mime === "image/jpeg" ||
          mime === "image/webp" ||
          mime === "image/gif"
            ? mime
            : "image/png") as Extract<PlanSource, { kind: "image" }>["mediaType"],
        };

    const result = await blueprintFromPlanSources([source]);
    if (!result.ok) {
      await db.planAnalysis.update({
        where: { id: analysis.id },
        data: { status: "FAILED", errorMessage: result.reason },
      });
      return NextResponse.json(
        { error: result.reason, id: analysis.id },
        { status: 422 },
      );
    }

    const updated = await db.planAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "SUCCEEDED",
        analysisJson: result.analysis as object,
        confidence: result.analysis.confidence,
        modelUsed: result.usage.model,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cacheHit: result.usage.cache_hit,
        durationMs: result.usage.duration_ms,
      },
    });

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      analysis: result.analysis,
      usage: result.usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "blueprint analysis failed";
    await db.planAnalysis.update({
      where: { id: analysis.id },
      data: { status: "FAILED", errorMessage: message },
    });
    return NextResponse.json({ error: message, id: analysis.id }, { status: 500 });
  }
}

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const rows = await db.planAnalysis.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      filename: true,
      status: true,
      confidence: true,
      pageCount: true,
      durationMs: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ analyses: rows });
}
