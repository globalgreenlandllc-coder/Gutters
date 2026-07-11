"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Clock,
  FileUp,
  Hammer,
  Home,
  MapPin,
  PenLine,
  Satellite,
  Sparkles,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getRecentAddresses } from "@/app/actions/estimate";

type JobType = "replacement" | "new";

/** Signature microlabel treatment (spec §2). */
const MICROLABEL =
  "font-mono text-[10px] font-bold uppercase tracking-[0.14em]";

/* ------------------------------------------------------------------ */
/*  Recent-address helpers                                            */
/*                                                                    */
/*  localStorage mirror of the server-side recents so the combobox    */
/*  still works for users who haven't successfully run an estimate    */
/*  yet (or while the server action is in flight). Ported from the    */
/*  old QuickStart card, which this page replaces.                    */
/* ------------------------------------------------------------------ */
const LOCAL_RECENTS_KEY = "gutters.recentAddresses";
const LOCAL_RECENTS_MAX = 8;

function readLocalRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

function pushLocalRecent(addr: string) {
  if (typeof window === "undefined") return;
  const trimmed = addr.trim();
  if (!trimmed) return;
  const existing = readLocalRecents().filter(
    (a) => a.toLowerCase() !== trimmed.toLowerCase(),
  );
  const next = [trimmed, ...existing].slice(0, LOCAL_RECENTS_MAX);
  try {
    window.localStorage.setItem(LOCAL_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable (private mode, quota); silently drop.
  }
}

/* ------------------------------------------------------------------ */
/*  StartOptions — the whole body of /dashboard/proposals/new         */
/* ------------------------------------------------------------------ */
export function StartOptions() {
  const reduce = useReducedMotion();
  const [satelliteOpen, setSatelliteOpen] = useState(false);
  // While the height animation runs the wrapper must clip; once settled
  // it must NOT clip, or the address dropdown gets cut off.
  const [panelSettled, setPanelSettled] = useState(false);

  // Fade/slide entrance (spec §3); `initial: false` renders statically
  // when the user prefers reduced motion.
  const enter = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.45, delay },
  });

  return (
    <div className="mt-8">
      {/* 01 — dark hero card */}
      <motion.div {...enter(0)}>
        <div className="relative max-w-[560px] overflow-hidden rounded-3xl bg-accent-950 p-8 text-white">
          <div
            aria-hidden
            className="absolute right-6 top-4 select-none text-[120px] font-semibold leading-none text-white/[0.06]"
          >
            01
          </div>
          <div className="relative">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-500/20 text-accent-300">
              <PenLine className="h-4 w-4" />
            </div>
            <div className={cn(MICROLABEL, "mt-5 text-white/40")}>
              Start here
            </div>
            <h2 className="mt-2 text-[22px] font-semibold tracking-tight">
              Build it yourself
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              Packages, materials, scope of work, payment schedule — the
              full proposal canvas. Live preview shows exactly what your
              homeowner receives.
            </p>

            {/* Sample estimate panel */}
            <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.04] p-4">
              <div className={cn(MICROLABEL, "text-white/40")}>
                Sample estimate
              </div>
              <div className="mt-3 space-y-2 text-sm">
                <SampleRow label="Eaves — 186 LF" value="$2,325" />
                <SampleRow label="Downspouts — 8 drops" value="$760" />
                <SampleRow label="Guards & misc" value="$315" />
              </div>
              <div className="mt-3 flex items-baseline justify-between border-t border-white/10 pt-3">
                <span className={cn(MICROLABEL, "text-white/40")}>Total</span>
                <span className="text-lg font-semibold text-accent-300">
                  $3,400
                </span>
              </div>
            </div>

            <Link
              href="/proposal?manual=1"
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-400"
            >
              Open the builder
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </motion.div>

      {/* Divider */}
      <motion.div
        {...enter(0.05)}
        className="mt-10 flex items-center gap-4"
        role="separator"
      >
        <span className="h-px flex-1 bg-zinc-200" />
        <span className={cn(MICROLABEL, "text-zinc-400")}>
          Or estimate it first
        </span>
        <span className="h-px flex-1 bg-zinc-200" />
      </motion.div>

      {/* Option cards */}
      <motion.div
        {...enter(0.1)}
        className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {/* 1 — Satellite takeoff (toggles the address panel below) */}
        <button
          type="button"
          onClick={() => setSatelliteOpen((o) => !o)}
          aria-expanded={satelliteOpen}
          aria-controls="satellite-address-panel"
          className="relative h-full rounded-2xl bg-accent-600 p-4 text-left text-white transition hover:bg-accent-700"
        >
          <span className="absolute right-3 top-3 rounded-md bg-white/15 px-1.5 py-0.5 text-[10px] font-bold">
            AI
          </span>
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
            <Satellite className="h-4 w-4" />
          </span>
          <span className="mt-3 block text-sm font-semibold">
            Satellite takeoff
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-white/70">
            Type an address — AI measures eaves, corners, and downspouts
            from aerial imagery.
          </span>
        </button>

        {/* 2 — Blueprint takeoff */}
        <Link
          href="/dashboard/blueprints/new"
          className="block h-full rounded-2xl border border-amber-200/70 bg-amber-50 p-4 text-left transition hover:border-amber-300"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
            <FileUp className="h-4 w-4" />
          </span>
          <span className="mt-3 block text-sm font-semibold text-zinc-900">
            Blueprint takeoff
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-zinc-600">
            Upload construction plans — AI reads the roof plan and
            classifies every edge.
          </span>
        </Link>

        {/* 3 — From a lead */}
        <Link
          href="/dashboard/leads"
          className="block h-full rounded-2xl border border-zinc-200 bg-white p-4 text-left transition hover:border-zinc-300"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-50 text-accent-700">
            <MapPin className="h-4 w-4" />
          </span>
          <span className="mt-3 block text-sm font-semibold text-zinc-900">
            From a lead
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-zinc-600">
            Pick a permit lead off the map and scan its address.
          </span>
        </Link>

        {/* 4 — Video walkthrough (coming soon) */}
        <div
          aria-disabled
          className="relative h-full cursor-default rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-left opacity-70"
        >
          <span className="absolute right-3 top-3 rounded-full border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-500">
            Soon
          </span>
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
            <Video className="h-4 w-4" />
          </span>
          <span className="mt-3 block text-sm font-semibold text-zinc-900">
            Video walkthrough
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-zinc-600">
            Walk the site on camera.
          </span>
        </div>
      </motion.div>

      {/* Expanding satellite address panel */}
      <AnimatePresence initial={false}>
        {satelliteOpen && (
          <motion.div
            key="satellite-panel"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0.1 : 0.4, ease: [0.22, 1, 0.36, 1] }}
            onAnimationStart={() => setPanelSettled(false)}
            onAnimationComplete={() => {
              if (satelliteOpen) setPanelSettled(true);
            }}
            className={panelSettled ? "overflow-visible" : "overflow-hidden"}
          >
            <div className="pt-4">
              <SatelliteAddressPanel />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SampleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-white/60">{label}</span>
      <span className="tabular-nums text-white/90">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Satellite address panel — combobox + job-type toggle              */
/* ------------------------------------------------------------------ */
function SatelliteAddressPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [value, setValue] = useState("");
  const [jobType, setJobType] = useState<JobType>("replacement");
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Autocomplete state. `recents` is the merged list (server-side past
  // estimate addresses + localStorage). `highlight` tracks keyboard
  // focus within the dropdown so Enter selects the active row.
  const [recents, setRecents] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const blurTimer = useRef<number | null>(null);

  // Focus the input as soon as the panel mounts (preventScroll so the
  // expand animation isn't yanked around by the browser).
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Hydrate localStorage immediately on mount, then fetch the server
  // copy in the background and merge — server wins on dedupe.
  useEffect(() => {
    setRecents(readLocalRecents());
    let cancelled = false;
    getRecentAddresses()
      .then((server) => {
        if (cancelled) return;
        const local = readLocalRecents();
        const seen = new Set<string>();
        const merged: string[] = [];
        for (const a of [...server, ...local]) {
          const k = a.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(a);
          if (merged.length >= LOCAL_RECENTS_MAX) break;
        }
        setRecents(merged);
      })
      .catch(() => {
        // Server action failed (DB cold-start, not signed in). Fall
        // back to the localStorage list we already loaded — better
        // than wiping the dropdown.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter the dropdown by the current input. Empty input shows
  // everything; typing narrows by case-insensitive substring.
  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter((a) => a.toLowerCase().includes(q));
  }, [recents, value]);

  const showDropdown = focused && suggestions.length > 0;

  function goAddress(addr?: string) {
    const target = (addr ?? value).trim();
    if (!target || submitting) return;
    setSubmitting(true);
    // Remember the entered address right away — even if the run fails
    // later, the user may want to retype/edit it from the dropdown
    // rather than re-typing from scratch.
    pushLocalRecent(target);
    router.push(
      `/estimate?address=${encodeURIComponent(target)}&jobType=${jobType}`,
    );
  }

  return (
    <div
      id="satellite-address-panel"
      className="rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-card"
    >
      <div className={cn(MICROLABEL, "text-accent-600")}>
        Satellite takeoff
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Enter while a dropdown row is highlighted picks that row,
          // otherwise submits whatever's in the input.
          if (highlight >= 0 && suggestions[highlight]) {
            goAddress(suggestions[highlight]);
          } else {
            goAddress();
          }
        }}
        className="mt-3"
      >
        <label
          htmlFor="satellite-address-input"
          className={cn(MICROLABEL, "text-zinc-400")}
        >
          Property address
        </label>
        <div className="relative mt-1.5">
          <div
            className={cn(
              "flex h-11 items-center gap-2 rounded-lg border bg-white pl-3.5 pr-3 transition",
              focused
                ? "border-accent-600 ring-2 ring-accent-600/15"
                : "border-zinc-200",
            )}
          >
            <MapPin
              className={cn(
                "h-4 w-4 shrink-0 transition",
                focused ? "text-accent-600" : "text-zinc-400",
              )}
            />
            <input
              ref={inputRef}
              id="satellite-address-input"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setHighlight(-1);
              }}
              onFocus={() => {
                if (blurTimer.current) {
                  window.clearTimeout(blurTimer.current);
                  blurTimer.current = null;
                }
                setFocused(true);
              }}
              onBlur={() => {
                // Defer so a mousedown on a dropdown row gets to run
                // before the dropdown unmounts. setTimeout is the
                // standard combobox pattern for this.
                blurTimer.current = window.setTimeout(() => {
                  setFocused(false);
                  setHighlight(-1);
                }, 120);
              }}
              onKeyDown={(e) => {
                if (!showDropdown) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) =>
                    h + 1 >= suggestions.length ? 0 : h + 1,
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) =>
                    h <= 0 ? suggestions.length - 1 : h - 1,
                  );
                } else if (e.key === "Escape") {
                  setHighlight(-1);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="1247 Maple Ridge Drive, Austin, TX 78704"
              autoComplete="off"
              role="combobox"
              aria-expanded={showDropdown}
              aria-autocomplete="list"
              className="w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
            />
          </div>

          {showDropdown && (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-white py-1.5 shadow-card"
            >
              <li
                className={cn(
                  MICROLABEL,
                  "px-3 pb-1 pt-0.5 text-zinc-400",
                )}
              >
                Recent addresses
              </li>
              {suggestions.map((s, i) => (
                <li key={s} role="option" aria-selected={i === highlight}>
                  <button
                    type="button"
                    // mousedown fires before input blur — picks the
                    // option before the dropdown unmounts.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      goAddress(s);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition",
                      i === highlight
                        ? "bg-accent-50 text-accent-900"
                        : "text-zinc-700 hover:bg-zinc-50",
                    )}
                  >
                    <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    <span className="truncate">{s}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          {/* Job-type toggle — affects scope-of-work language downstream */}
          <div className="inline-flex items-center gap-2">
            <span className={cn(MICROLABEL, "text-zinc-400")}>Job</span>
            <div className="inline-flex rounded-lg border border-zinc-200 p-0.5">
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
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition",
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

          <button
            type="submit"
            disabled={!value.trim() || submitting}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            {submitting ? "Starting…" : "Run takeoff"}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
