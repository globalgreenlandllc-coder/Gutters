"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
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
import BlueprintUploader from "@/components/blueprints/BlueprintUploader";

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
/*                                                                    */
/*  Row 1: the two real tools, immediately usable on load.            */
/*  Row 2: divider.                                                   */
/*  Row 3: secondary starts (manual builder, leads, video-soon).      */
/* ------------------------------------------------------------------ */
export function StartOptions() {
  const reduce = useReducedMotion();

  // Fade/slide entrance (spec §3); `initial: false` renders statically
  // when the user prefers reduced motion.
  const enter = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.45, delay },
  });

  return (
    <div className="mt-6">
      {/* Row 1 — Satellite + Blueprint, always visible, ready to use.
          items-start: the uploader card is taller and shouldn't
          stretch the satellite card to match. */}
      <motion.div
        {...enter(0)}
        className="grid items-start gap-4 lg:grid-cols-2"
      >
        <SatelliteTakeoffCard />

        {/* Blueprint takeoff — uploader embedded, no navigation away. */}
        <div className="rounded-2xl border border-zinc-200/70 bg-white p-6 shadow-card">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <FileUp className="h-4 w-4" />
            </span>
            <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">
              Blueprint takeoff
            </h2>
          </div>
          <p className="mt-3 text-sm text-zinc-500">
            Upload construction plans — AI reads the roof plan and
            classifies every edge.
          </p>
          <div className="mt-4">
            <BlueprintUploader />
          </div>
        </div>
      </motion.div>

      {/* Row 2 — divider */}
      <motion.div
        {...enter(0.05)}
        className="mt-8 flex items-center gap-4"
        role="separator"
      >
        <span className="h-px flex-1 bg-zinc-200" />
        <span className={cn(MICROLABEL, "text-zinc-400")}>
          Or start from something else
        </span>
        <span className="h-px flex-1 bg-zinc-200" />
      </motion.div>

      {/* Row 3 — secondary starts */}
      <motion.div {...enter(0.1)} className="mt-6 grid gap-4 md:grid-cols-3">
        {/* a — Build it yourself (compact dark card, no sample table) */}
        <div className="relative overflow-hidden rounded-2xl bg-accent-950 p-6 text-white">
          <div
            aria-hidden
            className="absolute right-4 top-2 select-none text-[64px] font-semibold leading-none text-white/[0.06]"
          >
            01
          </div>
          <div className="relative">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-500/20 text-accent-300">
              <PenLine className="h-4 w-4" />
            </div>
            <div className={cn(MICROLABEL, "mt-4 text-white/40")}>
              Start from scratch
            </div>
            <h2 className="mt-1.5 text-[15px] font-semibold tracking-tight">
              Build it yourself
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-white/60">
              Packages, materials, scope of work, payment schedule — the
              full proposal canvas.
            </p>
            <Link
              href="/proposal?manual=1"
              className="transition-smooth ring-focus-dark press-scale group mt-4 inline-flex items-center gap-2 rounded-lg bg-accent-500 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-accent-400"
            >
              Open the builder
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </Link>
          </div>
        </div>

        {/* b — From a lead.
            .press-scale's `transition: transform` shorthand is declared
            after .hover-lift in globals.css and would wipe the lift's
            box-shadow (and the border-color) transition, so restate the
            combined list locally; `!` is needed to out-cascade it, with a
            motion-reduce twin so reduced motion still collapses it. */}
        <Link
          href="/dashboard/leads"
          className="hover-lift press-scale ring-focus ![transition:transform_150ms_ease,box-shadow_200ms_cubic-bezier(0.32,0.72,0,1),border-color_150ms_ease] motion-reduce:![transition:none] block rounded-2xl border border-zinc-200/70 bg-white p-6 shadow-card hover:border-zinc-300"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-50 text-accent-700">
            <MapPin className="h-4 w-4" />
          </span>
          <span className="mt-4 block text-[15px] font-semibold tracking-tight text-zinc-900">
            From a lead
          </span>
          <span className="mt-1.5 block text-sm leading-relaxed text-zinc-500">
            Pick a permit lead off the map and scan its address.
          </span>
        </Link>

        {/* c — Video walkthrough (coming soon) */}
        <div
          aria-disabled
          className="relative cursor-default rounded-2xl border border-zinc-200 bg-zinc-50 p-6 opacity-70"
        >
          <span className="absolute right-3 top-3 rounded-full border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-500">
            Soon
          </span>
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
            <Video className="h-4 w-4" />
          </span>
          <span className="mt-4 block text-[15px] font-semibold tracking-tight text-zinc-900">
            Video walkthrough
          </span>
          <span className="mt-1.5 block text-sm leading-relaxed text-zinc-600">
            Walk the site on camera.
          </span>
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Satellite takeoff card — always-visible address form              */
/*  (combobox with recents + job-type toggle + Run AI takeoff)        */
/* ------------------------------------------------------------------ */
function SatelliteTakeoffCard() {
  const router = useRouter();

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
    <div className="rounded-2xl border border-zinc-200/70 bg-white p-6 shadow-card">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-50 text-accent-700">
          <Satellite className="h-4 w-4" />
        </span>
        <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">
          Satellite takeoff
        </h2>
        <span className="ml-auto rounded-md bg-accent-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
          AI
        </span>
      </div>
      <p className="mt-3 text-sm text-zinc-500">
        Type an address — AI measures eaves, corners, and downspouts from
        aerial imagery.
      </p>

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
        className="mt-5"
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
              "transition-smooth flex h-11 items-center gap-2 rounded-lg border bg-white pl-3.5 pr-3",
              focused
                ? "border-accent-500 ring-2 ring-accent-500/15"
                : "border-zinc-200",
            )}
          >
            <MapPin
              className={cn(
                "transition-smooth h-4 w-4 shrink-0",
                focused ? "text-accent-600" : "text-zinc-400",
              )}
            />
            <input
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
              className="anim-pop origin-top absolute left-0 right-0 top-full z-20 mt-1.5 max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-white py-1.5 shadow-card"
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
                      "transition-smooth flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
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

        {/* Job-type toggle — affects scope-of-work language downstream */}
        <div className="mt-4 flex items-center gap-2">
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
                    "transition-smooth ring-focus inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
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
          className="transition-smooth ring-focus press-scale mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent-600 px-3.5 text-[13px] font-semibold text-white shadow-sm hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {submitting ? "Starting…" : "Run AI takeoff"}
        </button>
      </form>
    </div>
  );
}
