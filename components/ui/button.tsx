"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-200 ring-focus disabled:opacity-50 disabled:cursor-not-allowed select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-600 text-white shadow-glow hover:bg-accent-700 active:translate-y-px",
  secondary:
    "bg-white text-zinc-800 border border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 shadow-sm",
  ghost: "text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100",
  outline:
    "border border-zinc-300 text-zinc-800 hover:border-accent-500/60 hover:text-accent-700 hover:bg-accent-50/40",
  danger:
    "bg-rose-600 text-white hover:bg-rose-700 shadow-[0_8px_24px_-6px_rgba(244,63,94,0.4)]",
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
