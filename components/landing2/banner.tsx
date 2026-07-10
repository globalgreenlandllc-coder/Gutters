import Link from "next/link";

export function Banner() {
  return (
    <div className="flex h-9 items-center bg-[#1c1a17] px-4 text-[12px] text-[#c9c4bb] md:px-8">
      <span className="hidden h-[7px] w-[7px] rounded-[2px] bg-[#f97316] md:inline-block" />
      <p className="mx-auto truncate font-mono text-[10.5px] font-bold uppercase tracking-wide">
        GutterScan now measures roofs in all 50 states &middot; Blueprint
        takeoffs are live
      </p>
      <Link
        href="/sign-in"
        className="hidden shrink-0 font-mono text-[10.5px] font-bold uppercase tracking-wide text-[#f97316] transition hover:text-[#fdba74] md:inline"
      >
        Read the announcement &rarr;
      </Link>
    </div>
  );
}
