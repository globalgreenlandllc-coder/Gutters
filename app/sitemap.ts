import type { MetadataRoute } from "next";

/** The indexable marketing surface. App/portal routes are deliberately
 *  absent (see robots.ts) — this is what we WANT Google to rank. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://www.gutterscan.com";
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/demo`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/sign-up`, changeFrequency: "yearly", priority: 0.5 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
