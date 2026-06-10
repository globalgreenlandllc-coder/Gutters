import { NextResponse } from "next/server";
import { issueSignedToken, presignUrl } from "@vercel/blob";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

/**
 * Presigned-URL upload path. Server issues a signed token with `put`
 * scope, derives a presigned URL, and returns it to the browser. The
 * browser then PUTs the file body straight to that URL with a plain
 * `fetch()` — no `@vercel/blob/client` SDK, no upload() / put() / mpu
 * branching, no chance of stale code routing to /mpu.
 *
 * Why this exists in addition to /api/blueprints/upload-url: that
 * route uses Vercel's `handleUpload()` which gives the @vercel/blob
 * client SDK a delegation token. The client SDK then decides whether
 * to go single-PUT or multipart and which endpoint to hit. Multiple
 * reports of stale JS chunks hitting /mpu even with `multipart: false`
 * set in source — this path takes the SDK out of the equation
 * entirely so we have a guaranteed-clean upload flow.
 */

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

const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
];
const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const blobToken = resolveBlobToken();
    if (!blobToken) {
      return NextResponse.json(
        { error: "BLOB_READ_WRITE_TOKEN not configured on this deployment" },
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

    const body = (await request.json()) as {
      filename?: string;
      mimeType?: string;
    };
    if (!body.filename || !body.mimeType) {
      return NextResponse.json(
        { error: "filename and mimeType are required" },
        { status: 400 },
      );
    }
    if (!ALLOWED_TYPES.includes(body.mimeType)) {
      return NextResponse.json(
        { error: `Unsupported mime type: ${body.mimeType}` },
        { status: 415 },
      );
    }

    // Namespace uploads under the user's DB ID so cross-user file
    // collisions and reverse-engineered pathnames don't accidentally
    // overwrite each other. Random suffix on top prevents same-user
    // collisions when the contractor re-uploads the same filename.
    const safeName = body.filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const random = Math.random().toString(36).slice(2, 10);
    const pathname = `blueprints/${user.id}/${random}-${safeName}`;

    const validUntil = Date.now() + 15 * 60 * 1000; // 15 min — covers slow 50 MB uploads
    const signedToken = await issueSignedToken({
      token: blobToken,
      pathname: "*", // scope to whole store; presignUrl pins to exact pathname below
      operations: ["put"],
      validUntil,
      allowedContentTypes: ALLOWED_TYPES,
      maximumSizeInBytes: MAX_BYTES,
    });
    const { presignedUrl } = await presignUrl(signedToken, {
      operation: "put",
      pathname,
      access: "public",
      allowedContentTypes: ALLOWED_TYPES,
      maximumSizeInBytes: MAX_BYTES,
      validUntil,
      // Disable random suffix so the stored pathname matches what we
      // just generated (and what the client posts back to /api/
      // blueprints). Without this, Vercel appends a per-upload random
      // string before the extension and the route can't find the blob
      // by pathname later. Our pathname already includes user.id +
      // random-token so collisions aren't an issue.
      addRandomSuffix: false,
    });

    return NextResponse.json({
      presignedUrl,
      pathname,
      validUntil,
    });
  } catch (e) {
    console.error("[/api/blueprints/presign] error", e);
    const message = e instanceof Error ? e.message : "presign failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
