import { auth } from "@clerk/nextjs/server";
import { get as blobGet, list as blobList } from "@vercel/blob";

import { db } from "@/lib/db";

export const maxDuration = 60;

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
 * Serve the original PDF bytes for a PlanAnalysis row so the takeoff
 * canvas can rasterize the actual roof-plan page (client-side, via
 * pdfjs) and show it UNDER the trace — "an exact copy of the roof"
 * the contractor traces gutters on, instead of a schematic redraw.
 *
 * Owner-scoped (findFirst by id + userId), like every other blueprint
 * route. Bytes come from the inlined base64 (`originalData`, small PDFs)
 * or are re-fetched from Vercel Blob (large PDFs) with the same recovery
 * the reanalyze route uses. Streams with long-lived private caching so
 * repeated page flips don't re-download.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return new Response("Unauthorized", { status: 401 });
  }
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  const { id } = await context.params;
  const row = await db.planAnalysis.findFirst({
    where: { id, userId: user.id },
    select: { originalData: true, mimeType: true, filename: true, pageImages: true },
  });
  if (!row) {
    return new Response("Not found", { status: 404 });
  }

  const isPdf =
    row.mimeType === "application/pdf" ||
    row.filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return new Response("Not a PDF", { status: 415 });
  }

  const headers = {
    "Content-Type": "application/pdf",
    // Private (it's owner-scoped, behind auth) but cacheable in the
    // browser so flipping sheets / re-opening the takeoff is instant.
    "Cache-Control": "private, max-age=3600",
  };

  // Fast path: bytes inlined on the row.
  if (row.originalData) {
    const buf = Buffer.from(row.originalData, "base64");
    return new Response(new Uint8Array(buf), { headers });
  }

  // Large-PDF path: re-fetch from Vercel Blob (bytes weren't inlined).
  const pageImages = row.pageImages as
    | Array<{ blobUrl?: string }>
    | null;
  const blobUrl = pageImages?.find((p) => p.blobUrl)?.blobUrl;
  if (!blobUrl) {
    return new Response("Source bytes unavailable", { status: 410 });
  }
  const token = resolveBlobToken();
  if (!token) {
    return new Response("Blob token not configured", { status: 500 });
  }
  let blobPath: string;
  try {
    blobPath = new URL(blobUrl).pathname.replace(/^\/+/, "");
  } catch {
    blobPath = blobUrl.replace(/^\/+/, "");
  }
  try {
    let blobResult = await blobGet(blobPath, { token, access: "public" }).catch(
      () => null,
    );
    if (!blobResult || blobResult.statusCode !== 200) {
      const prefix = blobPath.replace(/\.[a-z0-9]+$/i, "");
      const listing = await blobList({ token, prefix, limit: 5 });
      const match = listing.blobs.find((b) => b.pathname.startsWith(prefix));
      if (!match) return new Response("Blob not found", { status: 404 });
      blobResult = await blobGet(match.pathname, { token, access: "public" });
      if (!blobResult || blobResult.statusCode !== 200) {
        return new Response("Blob fetch failed", { status: 502 });
      }
    }
    return new Response(blobResult.stream, { headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "blob fetch failed";
    return new Response(`Blob fetch failed: ${message}`, { status: 502 });
  }
}
