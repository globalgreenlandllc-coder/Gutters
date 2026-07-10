import Link from "next/link";
import { Container } from "./ui";

const COLUMNS: { title: string; links: string[] }[] = [
  {
    title: "Product",
    links: ["Takeoffs", "Estimates", "Proposals", "Blueprint Engine"],
  },
  {
    title: "Solutions",
    links: ["For Contractors", "For Franchises", "FAQ"],
  },
  {
    title: "Company",
    links: ["Blog", "About Us", "Careers", "Contact", "Privacy Policy", "Terms of Service"],
  },
];

export function Footer() {
  return (
    <footer className="bg-[#faf8f4] pt-16">
      <Container>
        <div className="grid gap-12 border-b border-[#eae6de] pb-14 md:grid-cols-[1.2fr_1fr]">
          <div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border-2 border-[#c7d0ff] px-3.5 py-1.5">
                <span className="font-display text-[15px] uppercase leading-none tracking-tight text-[#0d0d12]">
                  Gutterscan
                </span>
                <span className="inline-block h-2.5 w-2.5 bg-[#0d0d12]" />
              </span>
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#b3ada2]">
                Patent Pending
              </span>
            </div>
            <p className="mt-3 max-w-xs text-[13.5px] leading-relaxed text-[#8a857c]">
              The AI takeoff and proposal platform for gutter contractors.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <span className="rounded-md border border-[#e9e5dd] bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#57534b]">
                SOC 2
              </span>
              <span className="rounded-md border border-[#e9e5dd] bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#57534b]">
                Built on Aerial + Plan Data
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <p className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#b3ada2]">
                  {col.title}
                </p>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l}>
                      <Link
                        href="/sign-in"
                        className="text-[13.5px] text-[#57534b] transition hover:text-[#1c1a17]"
                      >
                        {l}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-3 py-6 text-[12px] text-[#8a857c] md:flex-row">
          <p>&copy; 2026 Gutters AI, Inc. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <Link href="/sign-in" className="transition hover:text-[#1c1a17]">
              Service Status
            </Link>
            <Link href="/sign-in" className="transition hover:text-[#1c1a17]">
              Security
            </Link>
            <Link
              href="/sign-in"
              aria-label="LinkedIn"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[#e9e5dd] bg-white text-[#57534b] transition hover:text-[#1c1a17]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4V8zm7.5 0h3.8v2.2h.05c.53-1 1.83-2.2 3.77-2.2 4.03 0 4.88 2.65 4.88 6.1V24h-4v-8.5c0-2.03-.04-4.64-2.83-4.64-2.83 0-3.27 2.2-3.27 4.5V24H8V8z" />
              </svg>
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  );
}
