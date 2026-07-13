import { NextResponse, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { get as blobGet, list as blobList } from "@vercel/blob";

import { db } from "@/lib/db";
import {
  blueprintFromPlanSourcesBestOf,
  type PlanSource,
} from "@/lib/ai/blueprint-from-plans";
import { humanizeAiError, isFatalAiOutage } from "@/lib/ai/humanize-error";
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
import { runBlueprintGates } from "@/lib/ai/blueprint-gates";
import { readAllElevations } from "@/lib/ai/read-elevations";
import { extractPlanVectors } from "@/lib/ai/pdf-vectors";
import { classifyPerimeterEdges, edgeTakeoffEnabled } from "@/lib/ai/classify-edges";
import { getLearnedCalibration } from "@/lib/ai/takeoff-corrections";
import { readRoofFromVectors } from "@/lib/ai/roof-from-vectors";
import { consumeLimit } from "@/lib/abuse/rate-limit";
import { POLICIES, EST_COST_CENTS } from "@/lib/abuse/policies";
import {
  checkAiSpendAllowed,
  recordSpend,
  estimateModelCostCents,
} from "@/lib/abuse/spend-guard";

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
    select: { id: true, role: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // This is the most expensive action in the app (3× Opus reads + the
  // ensemble). Guard order: request-rate limit, then the cost-aware
  // spend gate + circuit breaker. Both fail CLOSED on limiter errors.
  const isAdmin = user.role === "SUPER_ADMIN";
  if (!isAdmin) {
    const rl = await consumeLimit({
      policy: POLICIES.blueprintAnalyze,
      key: `user:${user.id}`,
      context: { userId: user.id, route: "/api/blueprints" },
    });
    if (!rl.ok) {
      return NextResponse.json(
        { error: rl.reason },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }
  }
  const spend = await checkAiSpendAllowed({
    userId: user.id,
    kind: "BLUEPRINT_ANALYSIS",
    estCostCents: EST_COST_CENTS.BLUEPRINT_ANALYSIS,
    isAdmin,
  });
  if (!spend.ok) {
    return NextResponse.json({ error: spend.reason }, { status: 503 });
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
        // A dead key/account fails EVERY Anthropic call downstream — the run
        // would assemble a garbage takeoff from whatever providers survive
        // (the 2026-07-11 outage stored a gemini-only 122 LF / 0-gable
        // estimate). Abort loudly; the FAILED message tells the owner what
        // to fix. Transient classifier errors still fall through.
        if (isFatalAiOutage(stage1.reason)) {
          await db.planAnalysis.update({
            where: { id: analysis.id },
            data: { status: "FAILED", errorMessage: humanizeAiError(stage1.reason) },
          });
          return;
        }
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

      // INDEPENDENT per-face elevation reads (Correction 1) — kicked off here
      // so they run CONCURRENTLY with the takeoff below. Each elevation is read
      // in its own blind call, then merged deterministically; the result only
      // adds review flags (defaults gables to flush), never inflates pricing.
      // Disable with BLUEPRINT_ELEVATION_READS=0. Never throws.
      const elevationReadsEnabled = process.env.BLUEPRINT_ELEVATION_READS !== "0";
      const elevationsP =
        isPdf && elevationReadsEnabled
          ? readAllElevations(source, stage1 && stage1.ok ? stage1.classification : null)
          : Promise.resolve(null);

      // Stage 2: geometry trace, constrained by Stage 1 findings. Best-of
      // ensemble — three independent Opus reads PLUS a Gemini read when a
      // Gemini key is configured (genuine cross-provider second opinion);
      // keep the most complete / in-envelope one.
      const geminiReaders = (await geminiAvailable())
        ? [() => geminiBlueprintFromPlan([source], { constraints, vectorGeometry })]
        : [];
      // Learning loop: soft prior distilled from this contractor's past
      // corrected takeoffs (PlanAnalysis.editedJson vs analysisJson pairs).
      // Guidance-only — injected into the read's user message; null when
      // there's no history or no actionable bias. Never throws.
      const calibration = await getLearnedCalibration(user.id);
      const result = await blueprintFromPlanSourcesBestOf(
        [source],
        {
          constraints,
          vectorGeometry,
          classification: stage1 && stage1.ok ? stage1.classification : null,
          learnedCalibration: calibration?.promptBlock ?? null,
        },
        3,
        geminiReaders,
      );
      if (!result.ok) {
        await recordSpend({
          userId: user.id,
          kind: "BLUEPRINT_ANALYSIS",
          costCents: EST_COST_CENTS.BLUEPRINT_ANALYSIS,
          meta: { planId: analysis.id, failed: true },
        });
        await db.planAnalysis.update({
          where: { id: analysis.id },
          data: { status: "FAILED", errorMessage: humanizeAiError(result.reason) },
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

      // Deterministic roof-engine gates (area gate + closure). Pure
      // validation: it only appends review notes, never changes the priced
      // geometry. Fold the flag lines into notes BEFORE the analysisJson
      // spread so they surface in the results panel, and stash the structured
      // flags under `_engine` for a future dedicated review UI.
      const gates = await runBlueprintGates({
        analysis: finalAnalysis,
        classification: stage1 && stage1.ok ? stage1.classification : null,
        pdfBase64: isPdf && source.kind === "pdf" ? source.base64 : null,
      });
      if (gates.notes.length > 0) {
        finalAnalysis.notes = [...finalAnalysis.notes, ...gates.notes];
        console.log(
          `[/api/blueprints after()] engine gates: ${gates.reviewFlags.length} flag(s) — ${gates.notes[0]}`,
        );
      }
      if (calibration?.promptBlock) {
        finalAnalysis.notes = [
          ...finalAnalysis.notes,
          `📚 Learned calibration applied — ${calibration.sampleCount} past corrected takeoff(s) from this account ` +
            `(median eave bias ${calibration.medianLfDeltaPct > 0 ? "+" : ""}${calibration.medianLfDeltaPct.toFixed(0)}%). ` +
            `The read was told where its history ran high/low; this plan's printed dimensions still win.`,
        ];
      }

      // Independent per-face elevation reads (started above, resolved now).
      const elevations = await elevationsP;
      if (elevations && elevations.review_flags.length > 0) {
        finalAnalysis.notes = [
          ...finalAnalysis.notes,
          ...elevations.review_flags.map((f) => `🧭 ${f}`),
        ];
        console.log(
          `[/api/blueprints after()] elevation reads: ${elevations.usage.calls} face(s), ${elevations.review_flags.length} flag(s)`,
        );
      }

      // v2 EDGE TAKEOFF — classify the plan's own vector outline edge-by-edge
      // (eave/rake/unknown + D.S. marks + dimension values) in one expensive
      // vision call. Stored on the row; the estimate path consumes it INSTEAD
      // of freehand runs + blind closure. Fail-safe: {ok:false} → v1 unchanged.
      let edgeTakeoff: Awaited<ReturnType<typeof classifyPerimeterEdges>> | null = null;
      if (
        edgeTakeoffEnabled() &&
        isPdf &&
        source.kind === "pdf" &&
        Array.isArray(vectorGeometry?.roof?.segments) &&
        (vectorGeometry?.roof?.segments?.length ?? 0) >= 4
      ) {
        try {
          const rsegs = vectorGeometry!.roof!.segments as number[][];
          const rlabels = vectorGeometry!.roof!.labels ?? [];
          const fp = finalAnalysis.building_footprint ?? [];
          let expectedAspect: number | undefined;
          if (fp.length >= 3) {
            const xs = fp.map((p) => p.x).filter(Number.isFinite);
            const ys = fp.map((p) => p.y).filter(Number.isFinite);
            const w = Math.max(...xs) - Math.min(...xs);
            const h = Math.max(...ys) - Math.min(...ys);
            if (w > 0 && h > 0) expectedAspect = Math.max(w, h) / Math.min(w, h);
          }
          const roof = readRoofFromVectors(
            rlabels,
            rsegs,
            expectedAspect ? { expectedAspect } : undefined,
          );
          if (roof && roof.perimeter.length > 4 && roof.perimeter.length <= 60) {
            edgeTakeoff = await classifyPerimeterEdges({
              source,
              outline: roof.perimeter,
              segments: rsegs,
              roofPageSize: {
                widthPt: vectorGeometry?.roof?.widthPt,
                heightPt: vectorGeometry?.roof?.heightPt,
              },
              footprint: vectorGeometry?.footprint ?? null,
              // Per-face elevation reads: the code-enforced gable budget —
              // every rake call is reconciled against the elevation the wall
              // actually faces (reconcile-edge-classes.ts).
              perFace: elevations?.per_face ?? null,
              // Thin framing linework — the truss-field arbiter reads
              // eave/gable straight off the sheet's truss arrays.
              fieldSegments: vectorGeometry?.roof?.fieldSegments ?? null,
            });
            if (edgeTakeoff.notes.length > 0) {
              finalAnalysis.notes = [...finalAnalysis.notes, ...edgeTakeoff.notes];
            }
            console.log(
              `[/api/blueprints after()] edge takeoff: ok=${edgeTakeoff.ok}` +
                (edgeTakeoff.ok
                  ? ` (${edgeTakeoff.classes.length} edges, ptPerFt=${edgeTakeoff.ptPerFt})`
                  : ` — ${edgeTakeoff.reason} (v1 path stays)`),
            );
          }
        } catch (e) {
          console.warn(
            `[/api/blueprints after()] edge takeoff threw (v1 path stays):`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      // Stash the classifier output alongside the geometry under
      // `_classifier` so the detail page can show it without a schema
      // migration. analysisJson is a free-form Json column.
      const analysisJson: Record<string, unknown> = {
        ...(finalAnalysis as unknown as Record<string, unknown>),
      };
      analysisJson._engine = {
        reviewFlags: gates.reviewFlags,
        scaleFtPerPx: gates.scaleFtPerPx,
        scheduleArea: gates.scheduleArea,
        roofMasses: gates.roofMasses,
        orientation: gates.orientation,
      };
      if (elevations) {
        analysisJson._perFace = {
          per_face: elevations.per_face,
          symmetry_assumed: false,
          elevation_unreadable: elevations.elevation_unreadable,
          usage: elevations.usage,
        };
      }
      if (stage1 && stage1.ok) {
        analysisJson._classifier = {
          classification: stage1.classification,
          usage: stage1.usage,
        };
      }
      // Stash the extracted text layer so it's inspectable on the detail
      // page (what dimensions/labels the model actually got).
      if (vectorGeometry) {
        // Strip the code-only field channel — bulky and never needed after
        // classification (recomputed on re-analyze).
        analysisJson._vectorGeometry = vectorGeometry.roof?.fieldSegments
          ? {
              ...vectorGeometry,
              roof: { ...vectorGeometry.roof, fieldSegments: undefined },
            }
          : vectorGeometry;
      }
      if (edgeTakeoff) {
        analysisJson._edgeTakeoff = edgeTakeoff;
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

      // Ledger the ACTUAL token-derived cost (floored at the flat
      // estimate — the per-face/Gemini/edge calls aren't in the totals).
      await recordSpend({
        userId: user.id,
        kind: "BLUEPRINT_ANALYSIS",
        provider: "anthropic",
        costCents: Math.max(
          estimateModelCostCents(result.usage.model, totalInputTokens, totalOutputTokens),
          EST_COST_CENTS.BLUEPRINT_ANALYSIS,
        ),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        meta: { planId: analysis.id, model: result.usage.model },
      });
    } catch (e) {
      // Failed runs still burned model calls — ledger the flat estimate.
      await recordSpend({
        userId: user.id,
        kind: "BLUEPRINT_ANALYSIS",
        costCents: EST_COST_CENTS.BLUEPRINT_ANALYSIS,
        meta: { planId: analysis.id, failed: true },
      });
      const message = humanizeAiError(
        e instanceof Error ? e.message : "blueprint analysis failed",
      );
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
