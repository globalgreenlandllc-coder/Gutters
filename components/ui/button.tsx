"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant =
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "danger"
  | "dark"
  | "gradient";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-all duration-150 ring-focus disabled:opacity-50 disabled:cursor-not-allowed select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-600 text-white shadow-sm hover:bg-accent-700 active:translate-y-px",
  secondary:
    "bg-white text-zinc-800 border border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 shadow-sm",
  ghost: "text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100",
  outline:
    "border border-zinc-300 text-zinc-800 hover:border-zinc-400 hover:text-ink hover:bg-zinc-50",
  danger: "bg-rose-600 text-white hover:bg-rose-700 shadow-sm",
  dark: "bg-ink text-white hover:bg-zinc-900 active:translate-y-px font-mono font-bold uppercase tracking-[0.12em]",
  gradient:
    "btn-gradient text-white hover:opacity-95 active:translate-y-px font-mono font-bold uppercase tracking-[0.12em]",
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
