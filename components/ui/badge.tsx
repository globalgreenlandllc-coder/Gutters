import { cn } from "@/lib/utils";

export function Badge({
  children,
  className,
  tone = "accent",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "accent" | "neutral";
}) {
  const tones = {
    accent:
      "bg-accent-500/10 text-accent-300 border-accent-400/20 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.1)]",
    neutral: "bg-white/5 text-zinc-300 border-white/10",
  } as const;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium tracking-wide uppercase",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
