import { NextResponse, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { get as blobGet, list as blobList } from "@vercel/blob";

import { db } from "@/lib/db";
import {
  blueprintFromPlanSourcesBestOf,
  type PlanSource,
} from "@/lib/ai/blueprint-from-plans";
import {
  geminiAvailable,
  geminiBlueprintFromPlan,
} from "@/lib/ai/blueprint-gemini";
import {
  classifyPlanSheets,
  classificationToConstraints,
} from "@/lib/ai/classify-plans";
import { clampBlueprintToEnvelope } from "@/lib/ai/clamp-blueprint";
import { reconcileEaves } from "@/lib/ai/reconcile-eaves";
import { extractPlanVectors } from "@/lib/ai/pdf-vectors";

function resolveBlobToken(): string | null {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.endsWith("_READ_WRITE_TOKEN") || k.endsWith("_BLOB_READ_WRITE_TOKEN")) {
      return v;
    }
  }
  return null;
}

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
    // Use the Vercel Blob SDK's get() to download the bytes server-
    // side with the read/write token. We CANNOT trust a raw fetch()
    // of the blob URL:
    //   - Despite presignUrl({access:"public"}), Vercel returns URLs
    //     on the .private.blob.vercel-storage.com host that 403 when
    //     fetched without auth.
    //   - Earlier rounds of "image.source.base64.data" / "pdf is not
    //     valid" errors from Anthropic were us base64-encoding the
    //     literal string "Forbidden" (the 403 body) and sending it
    //     as a PDF.
    // get(blobUrl, { token }) hits Vercel's API server-to-server with
    // the bearer token and returns an authenticated stream.
    if (isPdf) {
      const token = resolveBlobToken();
      if (!token) {
        await db.planAnalysis.update({
          where: { id: analysis.id },
          data: {
            status: "FAILED",
            errorMessage: "BLOB_READ_WRITE_TOKEN missing — cannot fetch blob",
          },
        });
        return NextResponse.json(
          { error: "BLOB_READ_WRITE_TOKEN not configured", id: analysis.id },
          { status: 500 },
        );
      }
      // Extract pathname from URL. get() accepts EITHER a URL or a
      // pathname; pathnames bypass URL-format validation. The user's
      // existing row was created when the client constructed
      // .public.blob.vercel-storage.com URLs, which the SDK rejects
      // ("Invalid URL: does not point to a Vercel Blob store") because
      // canonical blobs live on .private.blob.vercel-storage.com.
      // Pathname-based lookup is host-agnostic.
      let blobPath: string;
      try {
        const u = new URL(blobUrl);
        blobPath = u.pathname.replace(/^\/+/, "");
      } catch {
        // blobUrl wasn't a full URL — assume it's already a pathname.
        blobPath = blobUrl.replace(/^\/+/, "");
      }
      try {
        let blobResult = await blobGet(blobPath, {
          token,
          access: "public",
        }).catch(() => null);
        if (!blobResult || blobResult.statusCode !== 200) {
          // Fallback: pre-existing rows have a pathname that's missing
          // Vercel's random suffix (the client used to construct URLs
          // assuming addRandomSuffix=false, but the SDK's default added
          // a suffix anyway). Find the actual blob via prefix listing
          // — most uploads have at most one blob per prefix because we
          // namespace under userId/random-token.
          const prefix = blobPath.replace(/\.[a-z0-9]+$/i, ""); // strip ext
          const listing = await blobList({
            token,
            prefix,
            limit: 5,
          });
          const match = listing.blobs.find((b) => b.pathname.startsWith(prefix));
          if (!match) {
            throw new Error(
              `Could not find blob: get returned ${blobResult?.statusCode ?? "null"}, ` +
                `list(prefix="${prefix}") returned ${listing.blobs.length} results`,
            );
          }
          blobResult = await blobGet(match.pathname, {
            token,
            access: "public",
          });
          if (!blobResult || blobResult.statusCode !== 200) {
            throw new Error(
              `blob.get on fallback path "${match.pathname}" returned ${blobResult?.statusCode ?? "null"}`,
            );
          }
        }
        const chunks: Uint8Array[] = [];
        const reader = blobResult.stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const totalLen = chunks.reduce((n, c) => n + c.length, 0);
        const buf = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          buf.set(c, off);
          off += c.length;
        }
        // Sanity-check: PDFs start with %PDF-. If the bytes don't,
        // we'd send garbage to Anthropic and get the misleading
        // "not a valid PDF" error — fail loudly here instead.
        const magic = String.fromCharCode(...buf.slice(0, 5));
        if (!magic.startsWith("%PDF-")) {
          throw new Error(
            `Blob is not a valid PDF (first bytes: "${magic}"). ` +
              "Re-upload the file via the dashboard so the new mime " +
              "normalization is applied.",
          );
        }
        const pdfBase64 = Buffer.from(buf).toString("base64");
        source = { kind: "pdf", base64: pdfBase64 };
      } catch (e) {
        const message = e instanceof Error ? e.message : "blob fetch failed";
        await db.planAnalysis.update({
          where: { id: analysis.id },
          data: {
            status: "FAILED",
            errorMessage: `Blob fetch failed: ${message}`,
          },
        });
        return NextResponse.json(
          { error: `Blob fetch failed: ${message}`, id: analysis.id },
          { status: 502 },
        );
      }
    } else {
      // Images: URL source is fine — image byte signatures are
      // unambiguous, so Anthropic doesn't need the correct content-
      // type to interpret them. The URL still needs to be publicly
      // fetchable though; if image URLs start 403'ing we'll need to
      // route them through blob.get() the same way as PDFs.
      source = { kind: "image-url", url: blobUrl };
    }
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

      // Stage 1: sheet inventory. Only run for PDFs — direct image
      // uploads are single-page so classification adds no signal.
      // Skipping it on images keeps cost identical to the legacy path.
      const useTwoStage = isPdf;
      const stage1 = useTwoStage ? await classifyPlanSheets(source) : null;
      if (stage1 && !stage1.ok) {
        // Don't fail the whole run on classifier error — fall through
        // to the legacy single-call path so the contractor still gets
        // something to edit. Surface the classifier error in notes.
        console.warn(
          `[/api/blueprints after()] classifier failed (continuing without constraints): ${stage1.reason}`,
        );
      }
      const constraints =
        stage1 && stage1.ok
          ? classificationToConstraints(stage1.classification)
          : undefined;
      if (constraints) {
        console.log(
          `[/api/blueprints after()] classifier: roof_plan_page=${constraints.roof_plan_page} min_runs=${constraints.min_gutter_runs} min_ds=${constraints.min_downspouts}`,
        );
      }

      // Pull the PDF's real vector layer as ground truth so Stage 2
      // sizes/shapes from the architect's geometry instead of eyeballing
      // pixels: the CLEAN building outline + overall dimensions from the
      // foundation/floor plan (authoritative footprint), plus the roof-plan
      // lines for edge classification. Fail-safe → null on any error, which
      // keeps the existing vision-only behavior.
      const vectorGeometry =
        isPdf && source.kind === "pdf"
          ? await extractPlanVectors(source.base64, {
              footprintPage: constraints?.footprint_page ?? null,
              roofPage: constraints?.roof_plan_page ?? 1,
            })
          : null;

      // Stage 2: geometry trace, constrained by Stage 1 findings. Best-of
      // ensemble — three independent Opus reads PLUS a Gemini read when a
      // Gemini key is configured (genuine cross-provider second opinion);
      // keep the most complete / in-envelope one.
      const geminiReaders = (await geminiAvailable())
        ? [() => geminiBlueprintFromPlan([source], { constraints, vectorGeometry })]
        : [];
      const result = await blueprintFromPlanSourcesBestOf(
        [source],
        { constraints, vectorGeometry },
        3,
        geminiReaders,
      );
      if (!result.ok) {
        await db.planAnalysis.update({
          where: { id: analysis.id },
          data: { status: "FAILED", errorMessage: result.reason },
        });
        return;
      }

      // Defensive clamp: if Sonnet's per-run length_ft values blow
      // past the envelope cap derived by the classifier (real failure
      // mode — emitted 789 LF on a 64×51 house when the actual
      // perimeter is ~270 LF), scale them proportionally so the
      // priced LF lands at a believable number. Shape is preserved
      // because length_px isn't touched and the canvas is fit-to-
      // viewBox.
      const { analysis: clamped, clampNotes } = clampBlueprintToEnvelope(
        result.analysis,
        constraints,
      );
      if (clampNotes.length > 0) {
        clamped.notes = [...clamped.notes, ...clampNotes];
        console.log(
          `[/api/blueprints after()] clamp: ${clampNotes.length} note(s) — ${clampNotes[0]}`,
        );
      }

      // Deterministic closure: walk the footprint and recover any SYMMETRIC
      // dropped eave (e.g. front porch guttered, mirror rear patio dropped) by
      // copying the twin's measured length_ft; flag the rest. Fail-safe (any
      // error returns the input unchanged). Then re-clamp so an auto-added run
      // can't push the priced total past the envelope (idempotent if under).
      const { analysis: reconciled, reconcileNotes } = reconcileEaves(clamped);
      if (reconcileNotes.length > 0) {
        reconciled.notes = [...reconciled.notes, ...reconcileNotes];
        console.log(
          `[/api/blueprints after()] reconcile: ${reconcileNotes.length} note(s) — ${reconcileNotes[0]}`,
        );
      }
      const { analysis: finalAnalysis } = clampBlueprintToEnvelope(
        reconciled,
        constraints,
      );

      // Stash the classifier output alongside the geometry under
      // `_classifier` so the detail page can show it without a schema
      // migration. analysisJson is a free-form Json column.
      const analysisJson: Record<string, unknown> = {
        ...(finalAnalysis as unknown as Record<string, unknown>),
      };
      if (stage1 && stage1.ok) {
        analysisJson._classifier = {
          classification: stage1.classification,
          usage: stage1.usage,
        };
      }
      // Stash the extracted text layer so it's inspectable on the detail
      // page (what dimensions/labels the model actually got).
      if (vectorGeometry) {
        analysisJson._vectorGeometry = vectorGeometry;
      }

      // Telemetry rolls up both calls so the dashboard's "cost per
      // takeoff" number reflects reality. cacheHit reports the
      // geometry call only (the classifier prompt is cached too but
      // we don't surface it separately).
      const totalInputTokens =
        result.usage.input_tokens + (stage1?.ok ? stage1.usage.input_tokens : 0);
      const totalOutputTokens =
        result.usage.output_tokens +
        (stage1?.ok ? stage1.usage.output_tokens : 0);
      const totalDurationMs =
        result.usage.duration_ms +
        (stage1?.ok ? stage1.usage.duration_ms : 0);

      await db.planAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "SUCCEEDED",
          analysisJson: analysisJson as object,
          confidence: finalAnalysis.confidence,
          modelUsed: result.usage.model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheHit: result.usage.cache_hit,
          durationMs: totalDurationMs,
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
