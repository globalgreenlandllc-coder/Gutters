import { NextResponse, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  blueprintFromPlanSources,
  type PlanSource,
} from "@/lib/ai/blueprint-from-plans";

// Vision-on-plans takes 30-120s for large PDFs. Bump high — Vercel
// honors up to 300s on Pro. after() callbacks share the same budget,
// so this must cover both the queue write AND the analysis.
export const maxDuration = 300;

// Multipart-fallback cap. The Blob direct-upload path accepts up to 32 MB
// (Anthropic's PDF limit); this lower number is for the legacy multipart
// branch which still runs through Vercel's 4.5 MB serverless body limit
// anyway — keep it at 4 MB so the error is "file too large" rather than
// the opaque platform 413 you'd otherwise hit.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Derive the canonical MIME for the file extension when the wire-
 * provided mime is missing or generic (application/octet-stream).
 * Anthropic's vision API fetches blob URLs and validates the response
 * content-type; a PDF served as octet-stream gets routed through the
 * image validator and fails with a misleading "image.source.base64.
 * data" error.
 */
function normalizeMimeFromName(name: string, hinted?: string): string {
  if (hinted && hinted !== "application/octet-stream") return hinted;
  const ext = name.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return hinted ?? "application/octet-stream";
  }
}

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
    // Trust the file extension over the wire-provided mime — drag-from-
    // Finder strips file.type, so we sometimes get "application/octet-
    // stream" for what's actually a PDF. Anthropic's vision API fetches
    // the URL and rejects bytes with the wrong content-type, surfacing
    // as the misleading "image.source.base64.data: format invalid"
    // error path.
    mime = normalizeMimeFromName(filename, body.mimeType);
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
    mime = normalizeMimeFromName(file.name, file.type);
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

  // Build the PlanSource synchronously — it's just data shape massaging,
  // no I/O. Then defer the actual Claude analysis to after() so the
  // browser gets an immediate 202 + planId and can navigate to the
  // result page (which polls for SUCCEEDED). Previously a 12 MB PDF
  // would block the response for 90+ s and Vercel would kill the
  // function with an empty 500, crashing the client on res.json().
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
    await db.planAnalysis.update({
      where: { id: analysis.id },
      data: { status: "FAILED", errorMessage: "No file or blobUrl provided" },
    });
    return NextResponse.json(
      { error: "No file or blobUrl provided", id: analysis.id },
      { status: 400 },
    );
  }

  // Kick off the heavy work AFTER returning. Vercel keeps the function
  // alive up to maxDuration; the client doesn't wait for it. Status is
  // tracked on the planAnalysis row (QUEUED → SUCCEEDED | FAILED) and
  // pollable via GET /api/blueprints/[id].
  after(async () => {
    try {
      const srcSummary =
        "url" in source
          ? `url=${source.url.slice(0, 80)}…`
          : `base64-bytes=${source.base64.length}`;
      console.log(
        `[/api/blueprints after()] starting analysis: id=${analysis.id} kind=${source.kind} mime=${mime} isPdf=${isPdf} isImage=${isImage} ${srcSummary}`,
      );
      const result = await blueprintFromPlanSources([source]);
      if (!result.ok) {
        await db.planAnalysis.update({
          where: { id: analysis.id },
          data: { status: "FAILED", errorMessage: result.reason },
        });
        return;
      }
      await db.planAnalysis.update({
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
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "blueprint analysis failed";
      console.error("[/api/blueprints after()] analysis threw:", e);
      await db.planAnalysis
        .update({
          where: { id: analysis.id },
          data: { status: "FAILED", errorMessage: message },
        })
        .catch((updateErr) =>
          console.error(
            "[/api/blueprints after()] also failed to mark FAILED:",
            updateErr,
          ),
        );
    }
  });

  // Return immediately with 202 Accepted. Client navigates to
  // /estimate?planId=<id>, which polls GET /api/blueprints/[id] for
  // status.
  return NextResponse.json(
    {
      id: analysis.id,
      status: analysis.status,
    },
    { status: 202 },
  );
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
