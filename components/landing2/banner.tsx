import Link from "next/link";

export function Banner() {
  return (
    <div className="flex h-9 items-center bg-accent-950 px-4 text-[12px] text-white/60 md:px-8">
      <span className="hidden h-[7px] w-[7px] rounded-[2px] bg-accent-400 md:inline-block" />
      <p className="mx-auto min-w-0 truncate font-mono text-[10.5px] font-bold uppercase tracking-wide">
        GutterScan now measures roofs in all 50 states &middot; Blueprint
        takeoffs are live
      </p>
      <Link
        href="/sign-in"
        className="hidden shrink-0 font-mono text-[10.5px] font-bold uppercase tracking-wide text-accent-300 transition hover:text-accent-200 md:inline"
      >
        Read the announcement &rarr;
      </Link>
    </div>
  );
}
