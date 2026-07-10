import Link from "next/link";
import { clsx } from "clsx";

/** Tiny uppercase section eyebrow with a leading tick mark. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={clsx(
        "flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a857c]",
        className,
      )}
    >
      <span className="inline-block h-[7px] w-[7px] rounded-[2px] bg-[#1c1a17]" />
      {children}
    </p>
  );
}

export function PillLink({
  href,
  children,
  variant = "dark",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "dark" | "outline" | "light";
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex h-11 items-center justify-center gap-2 rounded-full px-6 text-[14px] font-medium transition",
        variant === "dark" &&
          "bg-[#1c1a17] text-[#faf8f4] hover:bg-[#33302b]",
        variant === "outline" &&
          "border border-[#d8d3ca] bg-transparent text-[#1c1a17] hover:border-[#1c1a17]",
        variant === "light" && "bg-white text-[#1c1a17] hover:bg-[#f1ede6]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Standard landing content column. */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("mx-auto w-full max-w-[1200px] px-5 md:px-8", className)}>
      {children}
    </div>
  );
}

/**
 * Split section header used across the page: eyebrow on top, big serif
 * heading on the left, supporting paragraph (and optional action) on the right.
 */
export function SectionHeader({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: React.ReactNode;
  copy: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div className="mt-6 grid gap-8 md:grid-cols-[1.15fr_0.85fr] md:items-end md:gap-16">
        <h2 className="font-display text-[30px] uppercase leading-[0.98] tracking-[-0.01em] text-[#1c1a17] md:text-[42px]">
          {title}
        </h2>
        <div className="max-w-md md:justify-self-end">
          <p className="text-[15px] leading-relaxed text-[#6e6a62]">{copy}</p>
          {action ? <div className="mt-6">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
