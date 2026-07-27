import type { MetadataRoute } from "next";

/**
 * Crawl rules. Marketing surfaces (/, /demo, legal) are indexable; the
 * signed-in app, the admin, APIs, and TOKENED CLIENT PORTALS (/p/…) are
 * not — a homeowner's proposal link must never show up in search.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/dashboard",
          "/worker",
          "/api/",
          "/p/",
          "/proposal",
          "/estimate",
          "/whoami",
        ],
      },
    ],
    sitemap: "https://www.gutterscan.com/sitemap.xml",
  };
}
