import { NextResponse } from "next/server";
import { runAIEstimatePipeline } from "@/lib/ai";
import { consumeLimit, requestIp } from "@/lib/abuse/rate-limit";
import { POLICIES } from "@/lib/abuse/policies";

// Anonymous landing-page teaser: run the real satellite engine on a
// visitor's address and return the TRACE ONLY — geometry to animate the
// wow, no measurements. The numbers (LF, downspout math, pricing) are
// the product; they unlock after the free signup. Deliberately omitted
// from the response: px-per-ft scale, measurements, LF totals, the
// aerial photo, engine notes. Without the scale, the geometry can't be
// turned back into footage.
//
// Cost containment (each call spends real Google API money):
//   edge:    strict per-IP req/min class in middleware
//   durable: 2/day/IP + 150/day global (fail-closed) below
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TeaserLine = { id: string; kind: "eave" | "rake"; points: { x: number; y: number }[] };

export async function POST(request: Request) {
  let address = "";
  try {
    const body = (await request.json()) as { address?: unknown };
    address = String(body?.address ?? "").trim();
  } catch {
    // fall through to the length check
  }
  if (address.length < 8 || address.length > 200) {
    return NextResponse.json(
      { ok: false, reason: "Enter a full street address, like 6220 97th Dr NE, Lake Stevens, WA." },
      { status: 400 },
    );
  }

  const ip = requestIp(request);
  const byIp = await consumeLimit({
    policy: POLICIES.teaserScan,
    // Local dev / missing proxy headers share one bucket — fine, the
    // global cap is the real backstop.
    key: ip ? `ip:${ip}` : "ip:unknown",
    context: { ip: ip ?? undefined, route: "/api/teaser" },
  });
  if (!byIp.ok) {
    return NextResponse.json(
      { ok: false, reason: byIp.reason, signup: true },
      { status: 429, headers: { "Retry-After": String(byIp.retryAfterSec) } },
    );
  }
  const global = await consumeLimit({
    policy: POLICIES.teaserGlobal,
    key: "global",
    context: { ip: ip ?? undefined, route: "/api/teaser" },
  });
  if (!global.ok) {
    return NextResponse.json(
      { ok: false, reason: global.reason, signup: true },
      { status: 429, headers: { "Retry-After": String(global.retryAfterSec) } },
    );
  }

  try {
    const result = await runAIEstimatePipeline(address);
    const eaves = redactLines(result.eaves);
    if (eaves.length === 0) {
      return NextResponse.json(
        { ok: false, reason: "Couldn't read a roof at that address — check the street number and try again." },
        { status: 422 },
      );
    }
    return NextResponse.json({
      ok: true,
      teaser: {
        eaves,
        rakes: redactLines(result.rakes ?? []),
        downspouts: (result.downspouts ?? []).map((d) => ({
          id: d.id,
          x: d.x,
          y: d.y,
        })),
        perimeter: result.roofStructure?.perimeter ?? [],
        runCount: eaves.length,
        downspoutCount: (result.downspouts ?? []).length,
      },
    });
  } catch (e) {
    console.error("[teaser] pipeline failed", e);
    return NextResponse.json(
      { ok: false, reason: "The scanner hiccuped on that address — please try again in a minute." },
      { status: 502 },
    );
  }
}

function redactLines(
  lines: Array<{ id: string; kind: string; points: { x: number; y: number }[] }>,
): TeaserLine[] {
  return (lines ?? [])
    .filter((l) => Array.isArray(l.points) && l.points.length >= 2)
    .map((l) => ({
      id: l.id,
      kind: l.kind === "rake" ? "rake" : "eave",
      points: l.points.map((p) => ({ x: p.x, y: p.y })),
    }));
}
