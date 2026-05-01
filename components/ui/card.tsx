import { cn } from "@/lib/utils";

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative rounded-2xl border border-zinc-200 bg-white shadow-card",
        className,
      )}
    >
      {children}
    </div>
  );
}
