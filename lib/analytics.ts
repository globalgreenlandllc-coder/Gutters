// First-party web analytics — shared derivation helpers.
//
// Used by the ingest endpoint (app/api/track/route.ts) and the admin
// queries (app/actions/analytics.ts). Everything here is deterministic
// string mapping — no I/O — so both sides classify traffic identically.

/** "Online now" = a session heartbeat within this window. The client
 *  heartbeats every 25s while the tab is visible, so 60s tolerates two
 *  dropped beacons before someone reads as offline. */
export const LIVE_WINDOW_MS = 60_000;

/** Client rolls a new session after this much inactivity (industry-standard 30m). */
export const SESSION_IDLE_MS = 30 * 60_000;

export type Segment = "marketing" | "app" | "portal" | "admin";

export type Channel =
  | "direct"
  | "organic"
  | "paid"
  | "social"
  | "email"
  | "referral";

export const CHANNEL_LABELS: Record<Channel, string> = {
  direct: "Direct",
  organic: "Organic search",
  paid: "Paid ads",
  social: "Social",
  email: "Email",
  referral: "Referral",
};

/** Which product area a path belongs to. `marketing` = the public
 *  acquisition surface (landing, demo, sign-in/up, legal); `portal` =
 *  homeowners opening a proposal link (the contractor's customers, not
 *  prospects); `app` = signed-in product use; `admin` = us. */
export function segmentForPath(path: string): Segment {
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/p/")) return "portal";
  if (
    path.startsWith("/dashboard") ||
    path.startsWith("/estimate") ||
    path.startsWith("/proposal") ||
    path.startsWith("/worker")
  ) {
    return "app";
  }
  return "marketing";
}

const SEARCH_HOSTS = [
  "google.",
  "bing.",
  "duckduckgo.",
  "search.yahoo.",
  "search.brave.",
  "ecosia.",
  "startpage.",
  "yandex.",
  "baidu.",
];

const SOCIAL_HOSTS = [
  "facebook.",
  "fb.com",
  "instagram.",
  "l.instagram.",
  "twitter.",
  "t.co",
  "x.com",
  "linkedin.",
  "lnkd.in",
  "tiktok.",
  "youtube.",
  "youtu.be",
  "reddit.",
  "nextdoor.",
  "pinterest.",
  "threads.",
];

const PAID_MEDIUMS = new Set([
  "cpc",
  "ppc",
  "paid",
  "cpm",
  "cpv",
  "display",
  "paidsocial",
  "paid_social",
  "retargeting",
]);

function hostMatches(host: string, needles: string[]): boolean {
  return needles.some((n) => host === n || host.includes(n));
}

export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** First-touch acquisition channel for a session. Click-ids (gclid/fbclid)
 *  and paid utm_mediums win over the referrer so tagged ad traffic is
 *  never misfiled as organic/social. */
export function deriveChannel(input: {
  referrerHost: string | null;
  ownHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  hasClickId: boolean;
}): Channel {
  const medium = input.utmMedium?.toLowerCase() ?? "";
  if (input.hasClickId || PAID_MEDIUMS.has(medium)) return "paid";
  if (medium === "email" || input.utmSource?.toLowerCase() === "email") {
    return "email";
  }
  if (medium === "social" || medium === "organic_social") return "social";

  const ref = input.referrerHost;
  // Same-site referrers mean an in-site navigation started the session
  // (e.g. after a hard reload) — that's direct, not a referral.
  if (!ref || (input.ownHost && ref === input.ownHost)) {
    return input.utmSource ? "referral" : "direct";
  }
  if (hostMatches(ref, SEARCH_HOSTS)) return "organic";
  if (hostMatches(ref, SOCIAL_HOSTS)) return "social";
  return "referral";
}

const BOT_UA =
  /bot|crawl|spider|slurp|headless|lighthouse|prerender|preview|scrape|python-requests|python-urllib|curl\/|wget\/|axios\/|node-fetch|go-http-client|facebookexternalhit|whatsapp|telegrambot|discordbot|slackbot|linkedinbot|twitterbot|bingpreview|vercel-screenshot|checkly|pingdom|uptimerobot|datadog|newrelic|gtmetrix|pagespeed/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return true; // real browsers always send a UA
  return BOT_UA.test(ua);
}

export function parseDevice(ua: string): "desktop" | "mobile" | "tablet" {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android/i.test(ua)) return "mobile";
  return "desktop";
}

export function parseBrowser(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/chrome\/|crios\//i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua)) return "Safari";
  return "Other";
}

export function parseOs(ua: string): string {
  if (/windows/i.test(ua)) return "Windows";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/linux/i.test(ua)) return "Linux";
  return "Other";
}

/** Client-generated ids (crypto.randomUUID with dashes stripped, or
 *  a random fallback) — bounded charset + length so a forged beacon
 *  can't stuff junk into the primary key. */
export function isValidTrackingId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

export function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}
