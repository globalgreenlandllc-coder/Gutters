import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { list } from "@vercel/blob";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

/**
 * Parses a Vercel Blob token to surface its scope (read-only vs
 * read-write) and the store ID embedded in it. Lets us tell the user
 * exactly *why* the Blob backend is rejecting a token that's present
 * — e.g. "token belongs to store_abc but BLOB_STORE_ID says store_xyz".
 *
 * Token format: vercel_blob_<scope>_<storeId>_<secret>
 *   scope   = "rw" (read-write) or "ro" (read-only)
 *   storeId = store_XXXXXX-style ID
 *   secret  = random opaque suffix
 */
function parseBlobToken(token: string): {
  scope: "rw" | "ro" | null;
  storeIdFromToken: string | null;
} {
  // vercel_blob_rw_storeAbCdEfGh_secretStuff
  const m = /^vercel_blob_(rw|ro)_([A-Za-z0-9]+)_/.exec(token);
  if (!m) return { scope: null, storeIdFromToken: null };
  return {
    scope: m[1] as "rw" | "ro",
    storeIdFromToken: m[2],
  };
}

/**
 * Signed-upload-URL handshake for /api/blueprints.
 *
 * Vercel's serverless functions reject request bodies over ~4.5MB —
 * construction PDFs blow through that immediately. Workaround: have the
 * browser upload the file DIRECTLY to Vercel Blob storage using a token
 * we mint here, then post just the resulting URL to /api/blueprints to
 * kick off the Claude analysis.
 *
 * Auth token resolution: Vercel's newer Blob UI sometimes attaches the
 * token under store-prefixed names (e.g. <STORE_NAME>_READ_WRITE_TOKEN)
 * instead of the canonical BLOB_READ_WRITE_TOKEN. We accept any env var
 * matching *_READ_WRITE_TOKEN and pass it explicitly to handleUpload —
 * BLOB_STORE_ID / BLOB_WEBHOOK_PUBLIC_KEY are NOT auth credentials and
 * cannot be used for uploads even though Vercel auto-attaches them.
 */

/**
 * Walks process.env for any variable that looks like a Vercel Blob
 * read/write token. Canonical name is BLOB_READ_WRITE_TOKEN but Vercel
 * sometimes prefixes it with the store name. Returns the first match's
 * value, plus the var name we picked (for diagnostics).
 */
function resolveBlobToken(): { token: string | null; varName: string | null } {
  const direct = process.env.BLOB_READ_WRITE_TOKEN;
  if (direct) return { token: direct, varName: "BLOB_READ_WRITE_TOKEN" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.endsWith("_READ_WRITE_TOKEN") || k.endsWith("_BLOB_READ_WRITE_TOKEN")) {
      return { token: v, varName: k };
    }
  }
  return { token: null, varName: null };
}

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

  // Surface every Blob-prefixed env var by name (presence only — no
  // values) so the user can see exactly what Vercel attached and figure
  // out whether a token is hiding under a non-canonical name.
  const blobEnvNames = Object.keys(process.env)
    .filter((k) => k.includes("BLOB"))
    .sort();
  const { token, varName } = resolveBlobToken();

  // Inspect the token *structurally* before hitting the network — most
  // "access denied" errors are mismatched store IDs or read-only scope.
  const parsed = token
    ? parseBlobToken(token)
    : { scope: null, storeIdFromToken: null };
  const envStoreId = process.env.BLOB_STORE_ID || null;
  const storeIdMatch =
    parsed.storeIdFromToken && envStoreId
      ? parsed.storeIdFromToken === envStoreId
      : null;

  // Live API check — proves the token actually works with the Blob
  // backend, not just that an env var exists. list({limit:1}) is the
  // cheapest authenticated call.
  let liveCheck: { ok: boolean; error: string | null } = {
    ok: false,
    error: token ? null : "no token to test",
  };
  if (token) {
    try {
      await list({ limit: 1, token });
      liveCheck = { ok: true, error: null };
    } catch (e) {
      liveCheck = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return NextResponse.json({
    ok:
      Boolean(token) &&
      clerkOk &&
      Boolean(clerkId) &&
      dbOk &&
      liveCheck.ok,
    env: {
      BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      BLOB_STORE_ID: Boolean(process.env.BLOB_STORE_ID),
      BLOB_WEBHOOK_PUBLIC_KEY: Boolean(process.env.BLOB_WEBHOOK_PUBLIC_KEY),
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      CLERK_SECRET_KEY: Boolean(process.env.CLERK_SECRET_KEY),
    },
    blob: {
      tokenFound: Boolean(token),
      tokenSourceVar: varName,
      allBlobEnvNames: blobEnvNames,
      // The next four together pinpoint why the Blob backend may be
      // rejecting a token that is otherwise present.
      tokenScope: parsed.scope, // "rw" | "ro" | null
      tokenStoreId: parsed.storeIdFromToken,
      envStoreId,
      storeIdMatch, // true | false | null (null = can't compare)
      liveCheck,
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
    // Vercel's newer Blob UI sometimes attaches the auth token under a
    // store-prefixed name (e.g. MYSTORE_READ_WRITE_TOKEN) rather than
    // the canonical BLOB_READ_WRITE_TOKEN. resolveBlobToken() finds it
    // wherever it landed. BLOB_STORE_ID and BLOB_WEBHOOK_PUBLIC_KEY are
    // NOT auth credentials — even if they're attached, we still need a
    // read/write token to mint upload tokens.
    const { token: blobToken, varName: blobTokenVar } = resolveBlobToken();
    if (!blobToken) {
      const blobNames = Object.keys(process.env)
        .filter((k) => k.includes("BLOB"))
        .sort()
        .join(", ");
      return NextResponse.json(
        {
          error:
            "Vercel Blob read/write token is not attached to this deployment. " +
            "BLOB_STORE_ID and BLOB_WEBHOOK_PUBLIC_KEY are not auth tokens — " +
            "we need an env var ending in _READ_WRITE_TOKEN (canonical name " +
            "BLOB_READ_WRITE_TOKEN). Open your Blob store in Vercel → " +
            "`.env.local` tab → copy the BLOB_READ_WRITE_TOKEN line and add " +
            "it to Project Settings → Environment Variables. Then redeploy. " +
            `Currently attached BLOB-prefixed vars: ${blobNames || "(none)"}.`,
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
      // Pass the token explicitly so the SDK uses whichever env var name
      // we resolved (handles the store-prefixed case where the SDK's
      // default BLOB_READ_WRITE_TOKEN lookup would miss it).
      token: blobToken,
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
        tokenPayload: JSON.stringify({ userId: user.id, tokenVar: blobTokenVar }),
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
