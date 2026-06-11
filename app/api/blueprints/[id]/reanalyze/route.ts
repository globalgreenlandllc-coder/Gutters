import { NextResponse, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { get as blobGet, list as blobList } from "@vercel/blob";

import { db } from "@/lib/db";
import {
  blueprintFromPlanSources,
  type PlanSource,
} from "@/lib/ai/blueprint-from-plans";
import {
  classifyPlanSheets,
  classificationToConstraints,
} from "@/lib/ai/classify-plans";
import { clampBlueprintToEnvelope } from "@/lib/ai/clamp-blueprint";

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
    select: { id: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
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
        console.warn(
          `[/api/blueprints/${id}/reanalyze] classifier failed (continuing): ${stage1.reason}`,
        );
      }
      const constraints =
        stage1 && stage1.ok
          ? classificationToConstraints(stage1.classification)
          : undefined;

      const result = await blueprintFromPlanSources([finalSource], { constraints });
      if (!result.ok) {
        await db.planAnalysis.update({
          where: { id },
          data: { status: "FAILED", errorMessage: result.reason },
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
      const analysisJson: Record<string, unknown> = {
        ...(clamped as unknown as Record<string, unknown>),
      };
      if (stage1 && stage1.ok) {
        analysisJson._classifier = {
          classification: stage1.classification,
          usage: stage1.usage,
        };
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
          confidence: clamped.confidence,
          modelUsed: result.usage.model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheHit: result.usage.cache_hit,
          durationMs: totalDurationMs,
        },
      });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "blueprint re-analysis failed";
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
