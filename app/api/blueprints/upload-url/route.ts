import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

/**
 * Signed-upload-URL handshake for /api/blueprints.
 *
 * Vercel's serverless functions reject request bodies over ~4.5MB —
 * construction PDFs blow through that immediately. Workaround: have the
 * browser upload the file DIRECTLY to Vercel Blob storage using a token
 * we mint here, then post just the resulting URL to /api/blueprints to
 * kick off the Claude analysis.
 *
 * The @vercel/blob/client helper handles both halves of the handshake:
 *   action: "blob.generate-client-token" → we return a token
 *   action: "blob.upload-completed"      → Vercel calls back when upload finished
 *
 * Requires BLOB_READ_WRITE_TOKEN env var (auto-set when a Vercel Blob
 * store is created on the project).
 */
export async function POST(request: Request): Promise<NextResponse> {
  // Fail loud + actionable when the Blob store isn't wired up yet.
  // Without this check the user sees an opaque 500 with no clue how to
  // fix it. handleUpload() would throw the same error eventually but
  // wrapped in a stack trace that doesn't surface to the browser.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        error:
          "Vercel Blob isn't configured on this deployment. In your Vercel project: Storage → Create Database → Blob. The BLOB_READ_WRITE_TOKEN env var auto-attaches; redeploy and retry.",
      },
      { status: 500 },
    );
  }

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

  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        // PDF + common image types. PDFs are the main use case but raw
        // photos of a printed plan also need to work.
        allowedContentTypes: [
          "application/pdf",
          "image/png",
          "image/jpeg",
          "image/webp",
        ],
        // 32 MB is the practical ceiling for our pipeline: it's exactly
        // Anthropic's PDF input limit (also caps at 100 pages). Going
        // higher would let the upload succeed but Claude would reject the
        // analysis call, leaving a stranded blob and a failed
        // PlanAnalysis row. So we stop the user up-front.
        // Vercel Blob itself supports far larger objects (multi-GB) —
        // this is purely an Anthropic constraint.
        maximumSizeInBytes: 32 * 1024 * 1024,
        // Tokens are short-lived; the upload should start immediately.
        validUntil: Date.now() + 60 * 1000,
        // Pass userId so the upload-completed callback can authorize.
        tokenPayload: JSON.stringify({ userId: user.id }),
      }),
      onUploadCompleted: async () => {
        // No-op — we don't persist anything here. The browser will POST
        // the resulting URL back to /api/blueprints which creates the
        // PlanAnalysis row and triggers Claude.
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    // Full stack to Vercel runtime logs; message bubbles to the client so
    // the contractor doesn't have to dig through logs to know what failed.
    console.error("[/api/blueprints/upload-url] handleUpload error", e);
    const message = e instanceof Error ? e.message : "upload-url failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
