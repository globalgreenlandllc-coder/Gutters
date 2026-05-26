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

// Multipart-fallback cap. The Blob direct-upload path accepts up to 32 MB
// (Anthropic's PDF limit); this lower number is for the legacy multipart
// branch which still runs through Vercel's 4.5 MB serverless body limit
// anyway — keep it at 4 MB so the error is "file too large" rather than
// the opaque platform 413 you'd otherwise hit.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB

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

  // Two intake paths:
  //   1. JSON body with { blobUrl, filename, mimeType } — file already lives
  //      in Vercel Blob (uploaded directly from the browser bypassing
  //      Vercel's 4.5MB body limit). Recommended for any real PDF.
  //   2. multipart/form-data with a `file` field — works for files under
  //      ~4.5MB (Vercel cap). Kept as a fallback for environments without
  //      BLOB_READ_WRITE_TOKEN.
  const contentType = request.headers.get("content-type") ?? "";
  const isJsonBody = contentType.includes("application/json");

  let filename: string;
  let mime: string;
  let blobUrl: string | null = null;
  let base64: string | null = null;
  let isPdf = false;
  let isImage = false;

  if (isJsonBody) {
    const body = (await request.json()) as {
      blobUrl?: string;
      filename?: string;
      mimeType?: string;
    };
    if (!body.blobUrl || !body.filename) {
      return NextResponse.json(
        { error: "blobUrl and filename are required" },
        { status: 400 },
      );
    }
    blobUrl = body.blobUrl;
    filename = body.filename;
    mime = body.mimeType ?? "application/octet-stream";
    isPdf =
      mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
    isImage = mime.startsWith("image/");
  } else {
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
    base64 = buffer.toString("base64");
    filename = file.name;
    mime = file.type || "application/octet-stream";
    isPdf =
      mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    isImage = mime.startsWith("image/");
  }

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
      filename,
      mimeType: mime,
      // Blob URL path: don't duplicate the bytes into the row. URL goes
      // into pageImages so the detail page can still find a reference.
      originalData: base64,
      pageImages: blobUrl
        ? [{ pageIndex: 1, blobUrl, mediaType: mime }]
        : isPdf
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
    let source: PlanSource;
    if (blobUrl) {
      source = isPdf
        ? { kind: "pdf-url", url: blobUrl }
        : { kind: "image-url", url: blobUrl };
    } else if (base64) {
      source = isPdf
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
    } else {
      throw new Error("No file or blobUrl provided");
    }

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
