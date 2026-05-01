import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="relative h-8 w-8">
        <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-accent-400 to-accent-600 shadow-glow" />
        <svg
          viewBox="0 0 32 32"
          className="absolute inset-0 h-8 w-8 text-ink-950"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 12 L16 6 L26 12" />
          <path d="M8 12 L8 22 L24 22 L24 12" />
          <path d="M11 22 L11 26" />
          <path d="M21 22 L21 26" />
        </svg>
      </div>
      <div className="flex flex-col leading-none">
        <span className="font-display text-lg font-semibold tracking-tight">
          Gutters
        </span>
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          AI Takeoff
        </span>
      </div>
    </div>
  );
}
