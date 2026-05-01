"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-200 ring-focus disabled:opacity-50 disabled:cursor-not-allowed select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-gradient-to-b from-accent-400 to-accent-500 text-ink-950 hover:from-accent-300 hover:to-accent-400 shadow-glow active:translate-y-px",
  secondary:
    "bg-white/[0.06] text-zinc-100 border border-white/10 hover:bg-white/[0.1]",
  ghost: "text-zinc-300 hover:text-white hover:bg-white/[0.05]",
  outline:
    "border border-white/15 text-zinc-100 hover:border-accent-400/60 hover:text-accent-300",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-14 px-7 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
