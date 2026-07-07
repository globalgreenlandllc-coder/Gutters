"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  Hammer,
  Home,
  MapPin,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type JobType = "replacement" | "new";

export function NewEstimateDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [jobType, setJobType] = useState<JobType>("replacement");
  const [submitting, setSubmitting] = useState<"ai" | "manual" | null>(null);

  useEffect(() => {
    if (!open) {
      setAddress("");
      setJobType("replacement");
      setSubmitting(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function runAI() {
    const target = address.trim();
    if (!target) return;
    setSubmitting("ai");
    router.push(
      `/estimate?address=${encodeURIComponent(target)}&jobType=${jobType}`,
    );
  }

  function runManual() {
    setSubmitting("manual");
    router.push("/proposal?manual=1");
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-zinc-900/40" />
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg rounded-xl border border-zinc-200 bg-white shadow-elevated"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-50 text-accent-700">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
                    New estimate
                  </h2>
                  <p className="text-xs text-zinc-500">
                    Run an AI takeoff for an address, or start a blank
                    proposal and enter measurements yourself.
                  </p>
                </div>
              </div>

              {/* Job-type toggle — affects scope-of-work language downstream */}
              <div className="mt-5 flex items-center gap-2 text-xs">
                <span className="font-label text-[10px] text-zinc-400">
                  Job
                </span>
                <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5">
                  {(
                    [
                      { value: "replacement", label: "Replacement", Icon: Hammer },
                      { value: "new", label: "New construction", Icon: Home },
                    ] as const
                  ).map((opt) => {
                    const active = opt.value === jobType;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setJobType(opt.value)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition",
                          active
                            ? "bg-zinc-100 text-zinc-900"
                            : "text-zinc-500 hover:text-zinc-900",
                        )}
                      >
                        <opt.Icon className="h-3.5 w-3.5" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* AI from address */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  runAI();
                }}
                className="mt-5"
              >
                <label className="font-label text-[10px] text-zinc-400">
                  Property address
                </label>
                <div className="mt-1.5 flex h-12 items-center gap-2 rounded-lg border border-zinc-200 bg-white pl-3.5 pr-1.5 transition focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/15">
                  <MapPin className="h-4 w-4 shrink-0 text-zinc-400" />
                  <input
                    autoFocus
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="1247 Maple Ridge Drive, Austin, TX 78704"
                    autoComplete="off"
                    className="w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
                  />
                  <button
                    type="submit"
                    disabled={!address.trim() || submitting !== null}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent-600 px-3.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50 active:translate-y-px"
                  >
                    <Sparkles className="h-4 w-4" />
                    {submitting === "ai" ? "Starting…" : "AI estimate"}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </form>

              {/* Divider */}
              <div className="font-label my-5 flex items-center gap-3 text-[10px] text-zinc-400">
                <span className="h-px flex-1 bg-zinc-200" />
                or
                <span className="h-px flex-1 bg-zinc-200" />
              </div>

              {/* Manual entry */}
              <button
                type="button"
                onClick={runManual}
                disabled={submitting !== null}
                className="group flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left transition hover:border-accent-400 hover:bg-accent-50/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 transition group-hover:bg-accent-50 group-hover:text-accent-700">
                  <Pencil className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-zinc-900">
                    {submitting === "manual"
                      ? "Opening blank proposal…"
                      : "Start a manual estimate"}
                  </div>
                  <div className="text-xs text-zinc-500">
                    Skip AI — type the address, eaves, downspouts, and
                    pricing yourself.
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-zinc-400 transition group-hover:text-accent-600" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
