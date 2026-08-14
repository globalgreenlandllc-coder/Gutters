import { NextRequest, NextResponse } from "next/server";
import { getActiveApiKey } from "@/lib/api-keys";

/**
 * Address-autocomplete proxy. The client (landing hero, teaser scan, the
 * dashboard start card) debounces keystrokes into GET /api/places?q=…, and
 * this proxies Google Places Autocomplete with the VAULT key — the key
 * never ships to the browser (the landing surfaces are anonymous, so a
 * client-side key would be scrapable).
 *
 * Cost control, stacked:
 *  - middleware edge class caps req/min per IP (anonymous surface);
 *  - min 4 chars, US addresses only;
 *  - `sessiontoken` passthrough — Google bills autocomplete per SESSION
 *    (all keystrokes + one detail fetch count once) when the client sends
 *    a stable token per typing session, which our hook does.
 * Fail-soft: any upstream problem returns an empty list — autocomplete is
 * an enhancement, never a blocker for typing an address by hand.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const empty = () =>
  NextResponse.json(
    { predictions: [] },
    { headers: { "cache-control": "no-store" } },
  );

export async function GET(req: NextRequest) {
  try {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    const session = (req.nextUrl.searchParams.get("session") ?? "").trim();
    if (q.length < 4 || q.length > 120) return empty();

    const key =
      (await getActiveApiKey("GOOGLE_MAPS")) ??
      process.env.GOOGLE_MAPS_API_KEY ??
      "";
    if (!key) return empty();

    const url = new URL(
      "https://maps.googleapis.com/maps/api/place/autocomplete/json",
    );
    url.searchParams.set("input", q);
    url.searchParams.set("types", "address");
    url.searchParams.set("components", "country:us");
    url.searchParams.set("key", key);
    if (session && session.length <= 64) {
      url.searchParams.set("sessiontoken", session);
    }

    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return empty();
    const data = (await r.json()) as {
      status?: string;
      predictions?: { description?: string; place_id?: string }[];
    };
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      // REQUEST_DENIED usually means the Places API isn't enabled on the
      // key — log once per instance so the admin can flip it on.
      console.warn(`[places] autocomplete status ${data.status}`);
      return empty();
    }
    const predictions = (data.predictions ?? [])
      .slice(0, 5)
      .map((p) => ({ description: p.description ?? "", placeId: p.place_id ?? "" }))
      .filter((p) => p.description);
    return NextResponse.json(
      { predictions },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return empty();
  }
}
