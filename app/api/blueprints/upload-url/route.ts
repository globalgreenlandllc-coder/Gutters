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
/**
 * Diagnostic GET. Hit the route in your browser and you'll see which env
 * var is missing, whether Clerk auth resolved, and whether the DB user
 * row was found — without needing the Network tab. No secrets are
 * returned, just presence/absence flags.
 */
export async function GET(): Promise<NextResponse> {
  let clerkOk = false;
  let dbOk = false;
  let clerkErr: string | null = null;
  let dbErr: string | null = null;
  let clerkId: string | null = null;
  try {
    const a = await auth();
    clerkId = a.userId ?? null;
    clerkOk = true;
  } catch (e) {
    clerkErr = e instanceof Error ? e.message : String(e);
  }
  if (clerkId) {
    try {
      const u = await db.user.findUnique({
        where: { clerkId },
        select: { id: true },
      });
      dbOk = Boolean(u);
      if (!u) dbErr = "user row not found for this clerkId";
    } catch (e) {
      dbErr = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({
    ok:
      Boolean(process.env.BLOB_READ_WRITE_TOKEN) &&
      clerkOk &&
      Boolean(clerkId) &&
      dbOk,
    env: {
      BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      CLERK_SECRET_KEY: Boolean(process.env.CLERK_SECRET_KEY),
    },
    clerk: { ok: clerkOk, signedIn: Boolean(clerkId), error: clerkErr },
    db: { ok: dbOk, error: dbErr },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  // One outer try/catch so anything thrown — DB cold-start, Clerk hiccup,
  // request.json() on an empty body, handleUpload itself — surfaces as a
  // readable JSON error instead of a bare 500 with no body. Without this,
  // the browser sees "Failed to load resource: 500" and has no idea why.
  try {
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
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "application/pdf",
          "image/png",
          "image/jpeg",
          "image/webp",
        ],
        // 32 MB matches Anthropic's PDF input ceiling — going higher just
        // lets the upload succeed and the analysis fail later.
        maximumSizeInBytes: 32 * 1024 * 1024,
        validUntil: Date.now() + 60 * 1000,
        tokenPayload: JSON.stringify({ userId: user.id }),
      }),
      onUploadCompleted: async () => {
        // No-op: the browser POSTs the resulting URL back to /api/blueprints
        // which creates the PlanAnalysis row and triggers Claude.
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[/api/blueprints/upload-url] error", e);
    const message = e instanceof Error ? e.message : "upload-url failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
