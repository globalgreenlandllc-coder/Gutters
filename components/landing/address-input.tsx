"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { ArrowRight, MapPin, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-mock";

const SUGGESTIONS = [
  "1247 Maple Ridge Drive, Austin, TX",
  "82 Lakeshore Ave, Oakland, CA",
  "514 Birchwood Lane, Charlotte, NC",
];

export function AddressInput({ size = "lg" }: { size?: "lg" | "md" }) {
  const router = useRouter();
  const { session } = useSession();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(addr: string) {
    const target = (addr || "").trim();
    if (!target) return;
    const dest = `/estimate?address=${encodeURIComponent(target)}`;
    const route = session
      ? dest
      : `/sign-in?next=${encodeURIComponent(dest)}`;
    startTransition(() => router.push(route));
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18, duration: 0.6 }}
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
      className="relative mx-auto w-full max-w-2xl"
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border bg-white transition-all duration-300",
          focused
            ? "border-accent-500 shadow-glow-lg"
            : "border-zinc-200 shadow-sm",
          size === "lg" ? "h-16 pl-5 pr-2" : "h-14 pl-4 pr-2",
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
            size === "lg" ? "text-lg" : "text-base",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={pending}
          className={cn(
            "group inline-flex shrink-0 items-center gap-2 rounded-xl bg-accent-600 font-semibold text-white transition-all hover:bg-accent-700 active:translate-y-px disabled:opacity-60",
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
        <p className="mt-3 text-center text-xs text-zinc-500">
          Free demo · no credit card required
        </p>
      )}
    </motion.form>
  );
}
