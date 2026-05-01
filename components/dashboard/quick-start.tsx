"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, MapPin, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export function QuickStart() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  function go(addr?: string) {
    const target = (addr ?? value).trim();
    if (!target) return;
    router.push(`/estimate?address=${encodeURIComponent(target)}`);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-2xl border border-accent-200 bg-gradient-to-br from-accent-50 via-white to-sky-50 p-6 shadow-card"
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-accent-300/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-10 left-1/3 h-32 w-32 rounded-full bg-sky-300/20 blur-3xl" />

      <div className="relative">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-accent-200 bg-white/70 px-2.5 py-0.5 text-xs font-medium text-accent-700 backdrop-blur">
          <Sparkles className="h-3 w-3" />
          New estimate
        </div>
        <h2 className="font-display mt-4 text-balance text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">
          Type one address. Get an AI takeoff.
        </h2>
        <p className="mt-1 max-w-xl text-sm text-zinc-600">
          Eaves, downspouts, corners, waste — all auto-measured from aerial
          imagery in under a minute.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
          className={cn(
            "mt-5 flex h-14 items-center gap-2 rounded-2xl border bg-white pl-4 pr-2 transition",
            focused
              ? "border-accent-500 ring-2 ring-accent-500/15"
              : "border-zinc-200 shadow-sm",
          )}
        >
          <MapPin
            className={cn(
              "h-5 w-5 shrink-0 transition",
              focused ? "text-accent-600" : "text-zinc-400",
            )}
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="1247 Maple Ridge Drive, Austin, TX 78704"
            className="w-full bg-transparent text-base text-zinc-900 outline-none placeholder:text-zinc-400"
          />
          <button
            type="submit"
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent-600 px-4 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-700 active:translate-y-px"
          >
            <Sparkles className="h-4 w-4" />
            Estimate
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Try:</span>
          {[
            "1247 Maple Ridge Drive, Austin, TX",
            "82 Lakeshore Ave, Oakland, CA",
          ].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => go(s)}
              className="rounded-full border border-zinc-200 bg-white/70 px-2.5 py-1 text-zinc-600 transition hover:border-accent-400 hover:text-accent-700"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
