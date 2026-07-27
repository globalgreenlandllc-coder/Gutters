import type { Metadata } from "next";

/** Tokened homeowner portal — never indexable. robots.txt already
 *  disallows /p/, but a link posted publicly could still be indexed by
 *  URL alone; the robots meta forbids that outright. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
