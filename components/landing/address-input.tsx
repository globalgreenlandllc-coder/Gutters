"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { ArrowRight, MapPin, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SAMPLE_ADDRESS } from "@/lib/mock-estimate";

const SUGGESTIONS = [
  "1247 Maple Ridge Drive, Austin, TX",
  "82 Lakeshore Ave, Oakland, CA",
  "514 Birchwood Lane, Charlotte, NC",
];

export function AddressInput({ size = "lg" }: { size?: "lg" | "md" }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(addr: string) {
    const target = addr.trim() || SAMPLE_ADDRESS;
    startTransition(() => {
      router.push(`/estimate?address=${encodeURIComponent(target)}`);
    });
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.6 }}
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
      className="relative mx-auto w-full max-w-2xl"
    >
      <div
        className={cn(
          "relative flex items-center gap-2 rounded-2xl border bg-white/[0.04] backdrop-blur-2xl transition-all duration-300",
          focused
            ? "border-accent-400/60 shadow-glow-lg"
            : "border-white/10 shadow-card",
          size === "lg" ? "h-16 pl-5 pr-2" : "h-14 pl-4 pr-2",
        )}
      >
        <MapPin
          className={cn(
            "shrink-0 text-zinc-400 transition-colors",
            focused && "text-accent-400",
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
            "w-full bg-transparent text-zinc-100 placeholder:text-zinc-500 outline-none",
            size === "lg" ? "text-lg" : "text-base",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={pending}
          className={cn(
            "group inline-flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-b from-accent-400 to-accent-500 font-semibold text-ink-950 transition-all hover:from-accent-300 hover:to-accent-400 active:translate-y-px disabled:opacity-60",
            size === "lg" ? "h-12 px-5 text-base" : "h-10 px-4 text-sm",
          )}
        >
          {pending ? (
            <>
              <Sparkles className="h-4 w-4 animate-pulse" />
              Analyzing
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

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-zinc-500">
        <span className="text-zinc-600">Try:</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setValue(s);
              submit(s);
            }}
            className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-zinc-400 transition hover:border-accent-400/40 hover:text-accent-300"
          >
            {s}
          </button>
        ))}
      </div>
    </motion.form>
  );
}
