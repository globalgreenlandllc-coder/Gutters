import Link from "next/link";
import { Container } from "./ui";

const LINKS = [
  { label: "Product", href: "#engine" },
  { label: "Contractors", href: "#takeoffs" },
  { label: "Proposals", href: "#proposals" },
  { label: "Insights", href: "#insights" },
];

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border-2 border-[#c7d0ff] px-3.5 py-1.5">
      <span className="font-display text-[15px] uppercase leading-none tracking-tight text-[#0d0d12]">
        Gutterscan
      </span>
      <span className="inline-block h-2.5 w-2.5 bg-[#0d0d12]" />
    </span>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-[#eae6de] bg-[#faf8f4]/95 backdrop-blur">
      <Container className="flex h-[64px] items-center justify-between">
        <div className="flex items-center gap-10">
          <Link href="/" className="shrink-0">
            <Wordmark />
          </Link>
          <nav className="hidden items-center gap-7 lg:flex">
            {LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="text-[13.5px] font-medium text-[#57534b] transition hover:text-[#1c1a17]"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/sign-in"
            className="text-[13.5px] font-medium text-[#57534b] transition hover:text-[#1c1a17]"
          >
            Sign in
          </Link>
          <Link
            href="/sign-in"
            className="inline-flex h-9 items-center rounded-full bg-[#1c1a17] px-4 text-[13px] font-medium text-[#faf8f4] transition hover:bg-[#33302b]"
          >
            Get Started
          </Link>
        </div>
      </Container>
    </header>
  );
}
