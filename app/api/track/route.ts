import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import {
  clamp,
  deriveChannel,
  hostnameOf,
  isBotUserAgent,
  isValidTrackingId,
  KNOWN_EVENTS,
  parseBrowser,
  parseDevice,
  parseOs,
  segmentForPath,
} from "@/lib/analytics";

// First-party analytics beacon. Public (no auth required) and rate-limited
// at the edge under its own class in middleware.ts. The contract with the
// client tracker (components/analytics/tracker.tsx):
//
//   POST { type: "pageview"|"heartbeat"|"event", sid, vid, path, ref?, utm?, click?, name? }
//
// Every response is 204 — sendBeacon can't read bodies, and a broken
// beacon must never surface errors to visitors. Malformed/bot traffic is
// silently dropped; real failures are logged server-side only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const done = () => new NextResponse(null, { status: 204 });

export async function POST(req: NextRequest) {
  try {
    const ua = req.headers.get("user-agent");
    if (isBotUserAgent(ua)) return done();

    const raw = await req.text();
    if (!raw || raw.length > 4096) return done();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return done();
    }

    const sid = body.sid;
    const vid = body.vid;
    if (!isValidTrackingId(sid) || !isValidTrackingId(vid)) return done();
    const path = clamp(body.path, 300);
    if (!path || !path.startsWith("/")) return done();
    const now = new Date();

    if (body.type === "heartbeat") {
      // Presence ping — bump lastSeenAt/lastPath only. updateMany (not
      // update) so a heartbeat for an unknown session is a no-op instead
      // of a thrown P2025.
      await db.visitorSession.updateMany({
        where: { id: sid },
        data: { lastSeenAt: now, lastPath: path },
      });
      return done();
    }
    if (body.type !== "pageview" && body.type !== "event") return done();

    // Same-origin beacons carry Clerk cookies, so signed-in traffic links
    // to its DB user here — that link is what powers signup attribution.
    let userId: string | null = null;
    try {
      const { userId: clerkId } = await auth();
      if (clerkId) {
        const u = await db.user.findUnique({
          where: { clerkId },
          select: { id: true },
        });
        userId = u?.id ?? null;
      }
    } catch {
      // Anonymous or auth unavailable — track without a user link.
    }

    if (body.type === "event") {
      // Custom high-intent event (e.g. subscribe click). Allow-listed names
      // only. Recorded separately from page_views so it never inflates
      // pageview/bounce counts; the session is bumped so an active clicker
      // stays "live" and the feed can attribute who/where.
      const name = clamp(body.name, 64);
      if (!name || !KNOWN_EVENTS.has(name)) return done();
      await db.$transaction([
        db.analyticsEvent.create({
          data: { sessionId: sid, visitorId: vid, userId, name, path },
        }),
        db.visitorSession.updateMany({
          where: { id: sid },
          data: { lastSeenAt: now, lastPath: path, ...(userId ? { userId } : {}) },
        }),
      ]);
      return done();
    }

    const referrer = clamp(body.ref, 500);
    const referrerHost = hostnameOf(referrer);
    const utm = (body.utm ?? {}) as Record<string, unknown>;
    const utmSource = clamp(utm.source, 200);
    const utmMedium = clamp(utm.medium, 200);
    const channel = deriveChannel({
      referrerHost,
      ownHost: req.nextUrl.hostname.toLowerCase().replace(/^www\./, ""),
      utmSource,
      utmMedium,
      hasClickId: body.click === true,
    });

    // Vercel geo headers (absent in local dev — columns stay null).
    const country = clamp(req.headers.get("x-vercel-ip-country"), 8);
    const region = clamp(req.headers.get("x-vercel-ip-country-region"), 64);
    let city = clamp(req.headers.get("x-vercel-ip-city"), 128);
    if (city) {
      try {
        city = decodeURIComponent(city);
      } catch {
        // keep the raw header value
      }
    }

    await db.$transaction([
      db.visitorSession.upsert({
        where: { id: sid },
        // First pageview of the session: referrer/UTM/channel are locked
        // in here (first-touch) and never overwritten by later views.
        create: {
          id: sid,
          visitorId: vid,
          userId,
          segment: segmentForPath(path),
          entryPath: path,
          lastPath: path,
          referrer,
          referrerHost,
          channel,
          utmSource,
          utmMedium,
          utmCampaign: clamp(utm.campaign, 200),
          utmTerm: clamp(utm.term, 200),
          utmContent: clamp(utm.content, 200),
          device: ua ? parseDevice(ua) : null,
          browser: ua ? parseBrowser(ua) : null,
          os: ua ? parseOs(ua) : null,
          country,
          region,
          city,
          startedAt: now,
          lastSeenAt: now,
        },
        update: {
          lastSeenAt: now,
          lastPath: path,
          pageviews: { increment: 1 },
          // Link the user the moment a signed-in view arrives (e.g. the
          // post-signup redirect to /dashboard) — the anonymous → user
          // stitch that makes the acquisition funnel attributable.
          ...(userId ? { userId } : {}),
        },
      }),
      db.pageView.create({
        data: { sessionId: sid, visitorId: vid, userId, path },
      }),
    ]);
    return done();
  } catch (err) {
    console.warn("[track] beacon dropped:", err);
    return done();
  }
}
