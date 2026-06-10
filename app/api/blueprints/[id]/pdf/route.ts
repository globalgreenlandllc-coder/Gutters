import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { get as blobGet, list as blobList } from "@vercel/blob";

import { db } from "@/lib/db";

/**
 * Authenticated PDF proxy. The browser fetches /api/blueprints/<id>/pdf
 * to get the bytes of the underlying construction plan PDF — which it
 * then rasterizes via pdfjs-dist for the canvas background.
 *
 * The blob URL itself is gated (403 anonymous), so the browser can't
 * fetch it directly. This route uses BLOB_READ_WRITE_TOKEN server-side
 * to download the bytes and streams them to the browser. Row
 * ownership is checked first so contractors can't peek at each
 * other's plans.
 *
 * Caching: short-lived (5 min) — once the trace lands the browser
 * usually won't re-fetch, and rotating plans need fresh bytes.
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

export async function GET(
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
    select: { pageImages: true, mimeType: true, filename: true },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const pageImages = row.pageImages as
    | Array<{ blobUrl?: string }>
    | null;
  const blobUrl = pageImages?.[0]?.blobUrl;
  if (!blobUrl) {
    return NextResponse.json(
      { error: "No blob URL stored for this plan" },
      { status: 404 },
    );
  }

  const token = resolveBlobToken();
  if (!token) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN not configured" },
      { status: 500 },
    );
  }

  // Extract pathname from the stored URL (host-agnostic). Mirror of
  // the lookup we do in /api/blueprints — pathname-based fetch
  // bypasses URL-format validation in the SDK.
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
      // Prefix-list fallback for rows with random-suffix mismatch.
      const prefix = blobPath.replace(/\.[a-z0-9]+$/i, "");
      const listing = await blobList({ token, prefix, limit: 5 });
      const match = listing.blobs.find((b) => b.pathname.startsWith(prefix));
      if (!match) {
        return NextResponse.json(
          { error: "Blob not found in store" },
          { status: 404 },
        );
      }
      blobResult = await blobGet(match.pathname, {
        token,
        access: "public",
      });
      if (!blobResult || blobResult.statusCode !== 200) {
        return NextResponse.json(
          { error: "Blob fetch failed after fallback" },
          { status: 502 },
        );
      }
    }
    return new Response(blobResult.stream, {
      headers: {
        "content-type": row.mimeType || "application/pdf",
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "PDF proxy failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
