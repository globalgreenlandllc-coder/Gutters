"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { ArrowRight, MapPin, Play, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-mock";
import { SAMPLE_ADDRESS } from "@/lib/mock-estimate";
import { DemoFlow } from "./demo-flow";

const SUGGESTIONS = [
  "1247 Maple Ridge Drive, Austin, TX",
  "82 Lakeshore Ave, Oakland, CA",
  "514 Birchwood Lane, Charlotte, NC",
];

/**
 * Address-bar with green Estimate CTA.
 *
 * Behavior:
 *   • Signed-in users   → router-push to /estimate?address=...
 *   • Anonymous users   → open the inline DemoFlow modal
 *
 * The parent (Hero) can optionally pass `onOpenDemo` to lift the modal
 * state up — used so the hero's MiniDemo can open the same modal as
 * this input. When `onOpenDemo` is omitted, AddressInput falls back to
 * managing its own modal locally (so it still works in isolation).
 */
export function AddressInput({
  size = "lg",
  onOpenDemo,
}: {
  size?: "lg" | "md";
  onOpenDemo?: (address: string) => void;
}) {
  const router = useRouter();
  const { session } = useSession();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [pending, startTransition] = useTransition();
  // Local fallback when parent doesn't lift the modal state.
  const [localOpen, setLocalOpen] = useState(false);
  const [localAddress, setLocalAddress] = useState("");

  function openDemo(addr: string) {
    const target = addr.trim() || SAMPLE_ADDRESS;
    if (onOpenDemo) {
      onOpenDemo(target);
    } else {
      setLocalAddress(target);
      setLocalOpen(true);
    }
  }

  function submit(addr: string) {
    const target = (addr || "").trim();
    if (!target) return;
    if (!session) {
      openDemo(target);
      return;
    }
    const dest = `/estimate?address=${encodeURIComponent(target)}`;
    startTransition(() => router.push(dest));
  }

  return (
    <>
      <motion.form
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.6 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        className="relative w-full"
      >
        <div
          className={cn(
            "flex items-center gap-2 rounded-2xl border bg-white transition-all duration-300",
            focused
              ? "border-accent-500 shadow-glow-lg"
              : "border-zinc-200 shadow-sm",
            size === "lg" ? "h-14 pl-4 pr-2 sm:h-16 sm:pl-5" : "h-14 pl-4 pr-2",
          )}
        >
          <MapPin
            className={cn(
              "shrink-0 transition-colors",
              focused ? "text-accent-600" : "text-zinc-400",
              size === "lg" ? "h-5 w-5" : "h-4 w-4",
            )}
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Enter a property address…"
            className={cn(
              "w-full bg-transparent text-zinc-900 placeholder:text-zinc-400 outline-none",
              size === "lg" ? "text-base sm:text-lg" : "text-base",
            )}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={pending}
            className={cn(
              "group inline-flex shrink-0 items-center gap-2 rounded-xl bg-accent-600 font-semibold text-white transition-all hover:bg-accent-700 active:translate-y-px disabled:opacity-60",
              size === "lg"
                ? "h-11 px-4 text-sm sm:h-12 sm:px-5 sm:text-base"
                : "h-10 px-4 text-sm",
            )}
          >
            {pending ? (
              <>
                <Sparkles className="h-4 w-4 animate-pulse" />
                <span className="hidden sm:inline">Analyzing</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Estimate
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-xs text-zinc-500 lg:justify-start">
          <span className="text-zinc-400">Try:</span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setValue(s);
                submit(s);
              }}
              className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-zinc-600 transition hover:border-accent-400 hover:text-accent-700"
            >
              {s}
            </button>
          ))}
        </div>

        {!session && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-zinc-500 lg:justify-start">
            <button
              type="button"
              onClick={() => openDemo(value)}
              className="group inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-700 shadow-sm transition hover:border-accent-400 hover:text-accent-700"
            >
              <Play className="h-3 w-3 fill-current" />
              Watch 12-sec demo
            </button>
            <span>Free demo · no credit card required</span>
          </div>
        )}
      </motion.form>

      {/* Local fallback modal — only used when the parent doesn't
          lift the state via `onOpenDemo`. */}
      {!onOpenDemo && (
        <DemoFlow
          open={localOpen}
          address={localAddress}
          onClose={() => setLocalOpen(false)}
        />
      )}
    </>
  );
}
