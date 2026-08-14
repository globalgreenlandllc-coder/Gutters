"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Clock,
  FileUp,
  Hammer,
  Home,
  MapPin,
  PenLine,
  Ruler,
  Satellite,
  Sparkles,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAddressSuggestions } from "@/lib/use-address-suggestions";
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
/** Address typed into the landing-page teaser scan before signup —
 *  same literal as PENDING_SCAN_KEY in landing2/teaser-scan.tsx
 *  (duplicated to keep the landing bundle out of the dashboard). */
const PENDING_SCAN_KEY = "gutterscan.pendingAddress";

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
          Default stretch: with the compact dropzone the two cards are
          near-equal height, and matching frames read cleaner. */}
      <motion.div {...enter(0)} className="grid gap-5 lg:grid-cols-2">
        <SatelliteTakeoffCard />

        {/* Blueprint takeoff — uploader embedded, no navigation away. */}
        <div className="transition-smooth relative flex flex-col rounded-3xl border border-zinc-200/70 bg-white p-6 shadow-card hover:border-amber-200 hover:shadow-elevated sm:p-7">
          {/* Decor layer — clipped separately so nothing inside the card
              is affected by overflow rules. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl"
          >
            <div className="absolute -right-14 -top-14 h-44 w-44 rounded-full bg-amber-400/[0.08] blur-2xl" />
          </div>
          <div className="relative flex flex-1 flex-col">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_8px_20px_-8px_rgba(245,158,11,0.6)]">
                <FileUp className="h-5 w-5" />
              </span>
              <h2 className="text-[17px] font-semibold tracking-tight text-zinc-900">
                Blueprint takeoff
              </h2>
              {/* Honest label: the plan reader is the newest, hardest path.
                  Satellite is the launch hero; this earns the badge off. */}
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-bold tracking-wide text-amber-700 ring-1 ring-inset ring-amber-600/20">
                <span aria-hidden className="h-1 w-1 rounded-full bg-amber-500" />
                BETA
              </span>
            </div>
            <p className="mt-3.5 text-sm leading-relaxed text-zinc-500">
              Upload construction plans — AI reads the roof plan and
              classifies every edge. Uses one blueprint credit.
            </p>
            {/* flex-1 + h-full lets the dropzone stretch to the card's
                remaining height, so the two grid cards stay flush. */}
            <div className="mt-5 flex-1">
              <BlueprintUploader />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Row 2 — divider */}
      <motion.div
        {...enter(0.05)}
        className="mt-10 flex items-center gap-3"
        role="separator"
      >
        <span className="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-200 to-zinc-200" />
        <span
          className={cn(
            MICROLABEL,
            "rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-zinc-400",
          )}
        >
          Or start from something else
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent via-zinc-200 to-zinc-200" />
      </motion.div>

      {/* Row 3 — secondary starts */}
      <motion.div
        {...enter(0.1)}
        className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4"
      >
        {/* a — Measured on site: the fallback when neither AI path can
            run (no blueprints, unscannable address). Accent-tinted so
            the manual path reads as a first-class option, not an
            afterthought. Same hover treatment as the lead card — see
            its comment for the transition dance. */}
        <Link
          href="/dashboard/measure"
          className="hover-lift press-scale ring-focus ![transition:transform_150ms_ease,box-shadow_200ms_cubic-bezier(0.32,0.72,0,1),border-color_150ms_ease] motion-reduce:![transition:none] group relative block rounded-2xl border border-accent-200 bg-gradient-to-b from-accent-50/80 to-white p-5 shadow-card hover:border-accent-300"
        >
          <ArrowUpRight
            aria-hidden
            className="absolute right-4 top-4 h-4 w-4 -translate-x-1 translate-y-1 text-accent-500 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:transition-none"
          />
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cta-gradient text-white shadow-glow">
            <Ruler className="h-4 w-4" />
          </span>
          <span className="mt-4 block text-[15px] font-semibold tracking-tight text-zinc-900">
            Measured on site
          </span>
          <span className="mt-1.5 block text-sm leading-relaxed text-zinc-600">
            No plans, address won&apos;t scan? Type in your tape-measure
            runs and send the proposal from one page.
          </span>
        </Link>

        {/* b — Build it yourself (compact dark card, no sample table) */}
        <div className="relative overflow-hidden rounded-2xl bg-accent-950 p-5 text-white">
          <div
            aria-hidden
            className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-accent-500/25 blur-2xl"
          />
          <div
            aria-hidden
            className="absolute inset-0 [background-image:radial-gradient(rgba(255,255,255,0.13)_1px,transparent_1px)] [background-size:16px_16px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)] opacity-40"
          />
          <div className="relative">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-500/20 text-accent-300 ring-1 ring-inset ring-accent-400/30">
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

        {/* c — From a lead.
            .press-scale's `transition: transform` shorthand is declared
            after .hover-lift in globals.css and would wipe the lift's
            box-shadow (and the border-color) transition, so restate the
            combined list locally; `!` is needed to out-cascade it, with a
            motion-reduce twin so reduced motion still collapses it. */}
        <Link
          href="/dashboard/leads"
          className="hover-lift press-scale ring-focus ![transition:transform_150ms_ease,box-shadow_200ms_cubic-bezier(0.32,0.72,0,1),border-color_150ms_ease] motion-reduce:![transition:none] group relative block rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-card hover:border-zinc-300"
        >
          <ArrowUpRight
            aria-hidden
            className="absolute right-4 top-4 h-4 w-4 -translate-x-1 translate-y-1 text-zinc-400 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:transition-none"
          />
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200/70">
            <MapPin className="h-4 w-4" />
          </span>
          <span className="mt-4 block text-[15px] font-semibold tracking-tight text-zinc-900">
            From a lead
          </span>
          <span className="mt-1.5 block text-sm leading-relaxed text-zinc-500">
            Pick a permit lead off the map and scan its address.
          </span>
        </Link>

        {/* d — Video walkthrough (coming soon) */}
        <div
          aria-disabled
          className="relative cursor-default rounded-2xl border border-dashed border-zinc-300/80 bg-zinc-50/60 p-5 opacity-70"
        >
          <span className="absolute right-4 top-4 rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
            Soon
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 ring-1 ring-inset ring-zinc-200">
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

  // Landing-page teaser handoff: the visitor scanned an address before
  // signing up — pre-fill it so their first dashboard action is one
  // click ("finish the scan you started").
  const [fromTeaser, setFromTeaser] = useState(false);
  useEffect(() => {
    try {
      const pending = window.localStorage.getItem(PENDING_SCAN_KEY);
      if (pending && pending.trim().length >= 8) {
        setValue(pending.trim());
        setFromTeaser(true);
      }
    } catch {
      // private mode — nothing to pick up
    }
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

  // Live Google-Places suggestions (debounced /api/places proxy) — merged
  // BELOW the matching recents so muscle-memory picks stay on top.
  const { suggestions: placeSuggestions, endSession } = useAddressSuggestions(
    value,
    focused,
  );

  // Filter the dropdown by the current input. Empty input shows
  // everything; typing narrows by case-insensitive substring, then live
  // Places matches fill in after (deduped, capped at 8 rows).
  const { suggestions, liveSet } = useMemo(() => {
    const q = value.trim().toLowerCase();
    const base = q ? recents.filter((a) => a.toLowerCase().includes(q)) : recents;
    const seen = new Set(base.map((a) => a.toLowerCase()));
    const live: string[] = [];
    for (const p of placeSuggestions) {
      const k = p.description.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      live.push(p.description);
    }
    return {
      suggestions: [...base, ...live].slice(0, 8),
      liveSet: new Set(live),
    };
  }, [recents, value, placeSuggestions]);

  const showDropdown = focused && suggestions.length > 0;

  function goAddress(addr?: string) {
    const target = (addr ?? value).trim();
    if (!target || submitting) return;
    setSubmitting(true);
    endSession(); // close the Places billing session on submit
    // Remember the entered address right away — even if the run fails
    // later, the user may want to retype/edit it from the dropdown
    // rather than re-typing from scratch.
    pushLocalRecent(target);
    try {
      window.localStorage.removeItem(PENDING_SCAN_KEY);
    } catch {
      // ignore
    }
    router.push(
      `/estimate?address=${encodeURIComponent(target)}&jobType=${jobType}`,
    );
  }

  return (
    <div className="transition-smooth relative rounded-3xl border border-zinc-200/70 bg-white p-6 shadow-card hover:border-accent-200 hover:shadow-elevated sm:p-7">
      {/* Decor layer — clipped on its own so the recents dropdown can
          still overflow the card frame below. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl"
      >
        <div className="absolute -right-14 -top-14 h-48 w-48 rounded-full bg-accent-500/[0.08] blur-2xl" />
        <div className="dot-pattern absolute right-0 top-0 h-40 w-64 opacity-70 [mask-image:radial-gradient(180px_120px_at_100%_0%,black,transparent)]" />
      </div>
      <div className="relative">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cta-gradient text-white shadow-glow">
            <Satellite className="h-5 w-5" />
          </span>
          <h2 className="text-[17px] font-semibold tracking-tight text-zinc-900">
            Satellite takeoff
          </h2>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
              <span aria-hidden className="h-1 w-1 rounded-full bg-emerald-500" />
              FREE
            </span>
            <span className="bg-cta-gradient rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide text-white">
              AI
            </span>
          </span>
        </div>
        <p className="mt-3.5 text-sm leading-relaxed text-zinc-500">
          Type an address — AI measures eaves, corners, and downspouts from
          aerial imagery. Free on every plan, no credits used.
        </p>

        {fromTeaser && (
          <div className="anim-enter-fade mt-3 rounded-xl bg-accent-50 px-3 py-2 text-xs font-medium text-accent-800 ring-1 ring-inset ring-accent-200">
            ✨ Picked up the address from your landing-page scan — hit Run to
            unlock the full measurements.
          </div>
        )}

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
          <div className="relative mt-2">
            <div
              className={cn(
                "transition-smooth flex h-12 items-center gap-2.5 rounded-xl border bg-white pl-4 pr-3",
                focused
                  ? "border-accent-500 shadow-ring-soft"
                  : "border-zinc-200 shadow-sm",
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
                className="anim-pop origin-top absolute left-0 right-0 top-full z-20 mt-2 max-h-80 overflow-auto rounded-xl border border-zinc-200/80 bg-white py-1.5 shadow-elevated"
              >
                <li
                  className={cn(
                    MICROLABEL,
                    "px-3 pb-1 pt-0.5 text-zinc-400",
                  )}
                >
                  {liveSet.size > 0 ? "Addresses" : "Recent addresses"}
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
                      {liveSet.has(s) ? (
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-accent-500" />
                      ) : (
                        <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      )}
                      <span className="truncate">{s}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Job-type toggle — affects scope-of-work language downstream */}
          <div className="mt-4 flex items-center gap-2.5">
            <span className={cn(MICROLABEL, "text-zinc-400")}>Job</span>
            <div className="inline-flex rounded-full bg-zinc-100 p-1">
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
                    aria-pressed={active}
                    className={cn(
                      "transition-smooth ring-focus inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold",
                      active
                        ? "bg-white text-zinc-900 shadow-sm"
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

          {/* .press-scale would wipe .transition-smooth's shorthand, so the
              combined transition list is restated locally (same dance as
              the hover-lift tiles above). */}
          <button
            type="submit"
            disabled={!value.trim() || submitting}
            className="bg-cta-gradient ring-focus press-scale ![transition:transform_150ms_ease,box-shadow_200ms_ease,opacity_150ms_ease] motion-reduce:![transition:none] group mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white shadow-sm hover:shadow-glow disabled:cursor-not-allowed disabled:bg-none disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none"
          >
            <Sparkles className="h-4 w-4" />
            {submitting ? "Starting…" : "Run AI takeoff"}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </button>
        </form>
      </div>
    </div>
  );
}
