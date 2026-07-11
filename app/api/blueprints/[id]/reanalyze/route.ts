import { NextResponse, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { get as blobGet, list as blobList } from "@vercel/blob";

import { db } from "@/lib/db";
import { humanizeAiError, isFatalAiOutage } from "@/lib/ai/humanize-error";
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
import { runBlueprintGates } from "@/lib/ai/blueprint-gates";
import { readAllElevations } from "@/lib/ai/read-elevations";
import { classifyPerimeterEdges, edgeTakeoffEnabled } from "@/lib/ai/classify-edges";
import { readRoofFromVectors } from "@/lib/ai/roof-from-vectors";
import { consumeLimit } from "@/lib/abuse/rate-limit";
import { POLICIES, EST_COST_CENTS } from "@/lib/abuse/policies";
import {
  checkAiSpendAllowed,
  recordSpend,
  estimateModelCostCents,
} from "@/lib/abuse/spend-guard";

export const maxDuration = 300;

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

/**
 * Re-run the two-stage AI pipeline against an existing PlanAnalysis
 * row. Use case: prompt has been updated (sharper covered-projection
 * rules, tighter envelope clamp, new tier extraction) and the
 * contractor wants to refresh an old upload without re-uploading the
 * PDF. Returns 202 immediately; client polls GET /api/blueprints/[id]
 * for status the same way it does after a fresh upload.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
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

  // Same guard pair as the upload route — a re-analyze burns the same
  // Opus ensemble as a fresh upload, and it's a one-click button.
  const isAdmin = user.role === "SUPER_ADMIN";
  if (!isAdmin) {
    const rl = await consumeLimit({
      policy: POLICIES.blueprintAnalyze,
      key: `user:${user.id}`,
      context: { userId: user.id, route: "/api/blueprints/reanalyze" },
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

  const { id } = await context.params;
  const row = await db.planAnalysis.findFirst({
    where: { id, userId: user.id },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Reset to QUEUED so the UI polling shows in-progress instead of
  // the stale SUCCEEDED result while the re-run executes.
  await db.planAnalysis.update({
    where: { id },
    data: {
      status: "QUEUED",
      errorMessage: null,
    },
  });

  // Recover the source: either the original base64 blob (small PDFs)
  // or the Vercel Blob URL stored in pageImages.
  let source: PlanSource | null = null;
  const pageImages = row.pageImages as
    | Array<{ pageIndex: number; blobUrl?: string; base64?: string; mediaType?: string }>
    | null;
  const blobUrl = pageImages?.find((p) => p.blobUrl)?.blobUrl;
  const isPdf =
    row.mimeType === "application/pdf" ||
    row.filename.toLowerCase().endsWith(".pdf");

  if (blobUrl && isPdf) {
    const token = resolveBlobToken();
    if (!token) {
      await db.planAnalysis.update({
        where: { id },
        data: {
          status: "FAILED",
          errorMessage: "BLOB_READ_WRITE_TOKEN missing — cannot re-fetch blob",
        },
      });
      return NextResponse.json(
        { error: "BLOB_READ_WRITE_TOKEN not configured", id },
        { status: 500 },
      );
    }
    let blobPath: string;
    try {
      const u = new URL(blobUrl);
      blobPath = u.pathname.replace(/^\/+/, "");
    } catch {
      blobPath = blobUrl.replace(/^\/+/, "");
    }
    try {
      let blobResult = await blobGet(blobPath, {
        token,
        access: "public",
      }).catch(() => null);
      if (!blobResult || blobResult.statusCode !== 200) {
        const prefix = blobPath.replace(/\.[a-z0-9]+$/i, "");
        const listing = await blobList({ token, prefix, limit: 5 });
        const match = listing.blobs.find((b) => b.pathname.startsWith(prefix));
        if (!match) {
          throw new Error(
            `Blob not found: get returned ${blobResult?.statusCode ?? "null"}, ` +
              `list(prefix="${prefix}") returned ${listing.blobs.length} results`,
          );
        }
        blobResult = await blobGet(match.pathname, { token, access: "public" });
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
      const magic = String.fromCharCode(...buf.slice(0, 5));
      if (!magic.startsWith("%PDF-")) {
        throw new Error(
          `Blob is not a valid PDF (first bytes: "${magic}"). Re-upload the file.`,
        );
      }
      source = { kind: "pdf", base64: Buffer.from(buf).toString("base64") };
    } catch (e) {
      const message = e instanceof Error ? e.message : "blob fetch failed";
      await db.planAnalysis.update({
        where: { id },
        data: { status: "FAILED", errorMessage: `Blob fetch failed: ${message}` },
      });
      return NextResponse.json(
        { error: `Blob fetch failed: ${message}`, id },
        { status: 502 },
      );
    }
  } else if (row.originalData && isPdf) {
    source = { kind: "pdf", base64: row.originalData };
  } else if (row.originalData) {
    source = {
      kind: "image",
      base64: row.originalData,
      mediaType: "image/png",
    };
  }

  if (!source) {
    await db.planAnalysis.update({
      where: { id },
      data: {
        status: "FAILED",
        errorMessage:
          "Cannot recover source bytes for re-analysis. Re-upload the PDF.",
      },
    });
    return NextResponse.json(
      { error: "Source bytes unavailable — re-upload required", id },
      { status: 410 },
    );
  }

  const finalSource = source;
  after(async () => {
    try {
      console.log(`[/api/blueprints/${id}/reanalyze] starting re-analysis`);
      const stage1 = isPdf ? await classifyPlanSheets(finalSource) : null;
      if (stage1 && !stage1.ok) {
        // Dead key/account = every downstream Anthropic call fails too.
        // Abort with the plain billing/auth message instead of overwriting
        // a good stored analysis with a degraded one (see /api/blueprints).
        if (isFatalAiOutage(stage1.reason)) {
          await db.planAnalysis.update({
            where: { id },
            data: { status: "FAILED", errorMessage: humanizeAiError(stage1.reason) },
          });
          return;
        }
        console.warn(
          `[/api/blueprints/${id}/reanalyze] classifier failed (continuing): ${stage1.reason}`,
        );
      }
      const constraints =
        stage1 && stage1.ok
          ? classificationToConstraints(stage1.classification)
          : undefined;

      const vectorGeometry =
        isPdf && finalSource.kind === "pdf"
          ? await extractPlanVectors(finalSource.base64, {
              footprintPage: constraints?.footprint_page ?? null,
              roofPage: constraints?.roof_plan_page ?? 1,
            })
          : null;

      // Independent per-face elevation reads (Correction 1) — run concurrently
      // with the takeoff below. Same wire-in as the upload path.
      const elevationReadsEnabled = process.env.BLUEPRINT_ELEVATION_READS !== "0";
      const elevationsP =
        isPdf && elevationReadsEnabled
          ? readAllElevations(finalSource, stage1 && stage1.ok ? stage1.classification : null)
          : Promise.resolve(null);

      // Best-of ensemble: three independent Opus reads + a Gemini read when a
      // Gemini key is configured (cross-provider). Keep the best.
      const geminiReaders = (await geminiAvailable())
        ? [
            () =>
              geminiBlueprintFromPlan([finalSource], {
                constraints,
                vectorGeometry,
              }),
          ]
        : [];
      const result = await blueprintFromPlanSourcesBestOf(
        [finalSource],
        { constraints, vectorGeometry },
        3,
        geminiReaders,
      );
      if (!result.ok) {
        await recordSpend({
          userId: user.id,
          kind: "BLUEPRINT_ANALYSIS",
          costCents: EST_COST_CENTS.BLUEPRINT_ANALYSIS,
          meta: { planId: id, failed: true, reanalyze: true },
        });
        await db.planAnalysis.update({
          where: { id },
          data: { status: "FAILED", errorMessage: humanizeAiError(result.reason) },
        });
        return;
      }
      const { analysis: clamped, clampNotes } = clampBlueprintToEnvelope(
        result.analysis,
        constraints,
      );
      if (clampNotes.length > 0) {
        clamped.notes = [...clamped.notes, ...clampNotes];
      }
      // Deterministic closure (same as the upload path — keep both in sync):
      // recover symmetric dropped eaves, flag the rest, then re-clamp.
      const { analysis: reconciled, reconcileNotes } = reconcileEaves(clamped);
      if (reconcileNotes.length > 0) {
        reconciled.notes = [...reconciled.notes, ...reconcileNotes];
      }
      const { analysis: finalAnalysis } = clampBlueprintToEnvelope(
        reconciled,
        constraints,
      );

      // Deterministic roof-engine gates — same wire-in as the upload path.
      const gates = await runBlueprintGates({
        analysis: finalAnalysis,
        classification: stage1 && stage1.ok ? stage1.classification : null,
        pdfBase64: isPdf && finalSource.kind === "pdf" ? finalSource.base64 : null,
      });
      if (gates.notes.length > 0) {
        finalAnalysis.notes = [...finalAnalysis.notes, ...gates.notes];
      }

      const elevations = await elevationsP;
      if (elevations && elevations.review_flags.length > 0) {
        finalAnalysis.notes = [
          ...finalAnalysis.notes,
          ...elevations.review_flags.map((f) => `🧭 ${f}`),
        ];
      }

      // v2 EDGE TAKEOFF — one expensive vision call that classifies the
      // plan's own vector outline edge-by-edge (eave/rake/unknown + D.S.
      // marks + dimension values). Stored on the row; the estimate path
      // consumes it INSTEAD of freehand runs + blind closure. Fail-safe:
      // any miss stores {ok:false} and v1 behavior is unchanged.
      let edgeTakeoff: Awaited<ReturnType<typeof classifyPerimeterEdges>> | null = null;
      if (
        edgeTakeoffEnabled() &&
        isPdf &&
        finalSource.kind === "pdf" &&
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
              source: finalSource,
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
            if (!edgeTakeoff.ok) {
              console.warn(
                `[/api/blueprints/${id}/reanalyze] edge classifier failed (v1 path stays): ${edgeTakeoff.reason}`,
              );
            }
          }
        } catch (e) {
          console.warn(
            `[/api/blueprints/${id}/reanalyze] edge takeoff threw (v1 path stays):`,
            e instanceof Error ? e.message : e,
          );
        }
      }

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

      const totalInputTokens =
        result.usage.input_tokens + (stage1?.ok ? stage1.usage.input_tokens : 0);
      const totalOutputTokens =
        result.usage.output_tokens +
        (stage1?.ok ? stage1.usage.output_tokens : 0);
      const totalDurationMs =
        result.usage.duration_ms +
        (stage1?.ok ? stage1.usage.duration_ms : 0);

      await db.planAnalysis.update({
        where: { id },
        data: {
          status: "SUCCEEDED",
          analysisJson: analysisJson as Prisma.InputJsonValue,
          confidence: finalAnalysis.confidence,
          modelUsed: result.usage.model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheHit: result.usage.cache_hit,
          durationMs: totalDurationMs,
        },
      });

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
        meta: { planId: id, model: result.usage.model, reanalyze: true },
      });
    } catch (e) {
      await recordSpend({
        userId: user.id,
        kind: "BLUEPRINT_ANALYSIS",
        costCents: EST_COST_CENTS.BLUEPRINT_ANALYSIS,
        meta: { planId: id, failed: true, reanalyze: true },
      });
      const message = humanizeAiError(
        e instanceof Error ? e.message : "blueprint re-analysis failed",
      );
      console.error(`[/api/blueprints/${id}/reanalyze] threw:`, e);
      await db.planAnalysis
        .update({
          where: { id },
          data: { status: "FAILED", errorMessage: message },
        })
        .catch((err) =>
          console.error(
            `[/api/blueprints/${id}/reanalyze] also failed to mark FAILED:`,
            err,
          ),
        );
    }
  });

  return NextResponse.json({ id, status: "QUEUED" }, { status: 202 });
}
