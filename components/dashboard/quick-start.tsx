"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { upload } from "@vercel/blob/client";
import {
  ArrowRight,
  Clock,
  FileUp,
  Hammer,
  Home,
  Loader2,
  MapPin,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getRecentAddresses } from "@/app/actions/estimate";

type Source = "address" | "plans";
type JobType = "replacement" | "new";

// localStorage key for the address autocomplete recents. Mirrors the
// server-side list so the dropdown still works for users who haven't
// successfully run an estimate yet (or while the server action is in
// flight). Capped at LOCAL_RECENTS_MAX so the dropdown stays readable.
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

export function QuickStart() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<Source>("address");
  const [jobType, setJobType] = useState<JobType>("replacement");
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Filter the dropdown by the current input. Empty input shows everything;
  // typing narrows by case-insensitive substring (typical autocomplete UX).
  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter((a) => a.toLowerCase().includes(q));
  }, [recents, value]);

  const showDropdown =
    focused && source === "address" && suggestions.length > 0;

  // Switching the source toggle to "plans" hints that the user might be on
  // a new build — flip the job-type toggle along with it ONLY if the user
  // hasn't already overridden it. (Stored separately so re-clicking the
  // source toggle never blows away an explicit job-type pick.)
  const onSourceChange = (next: Source) => {
    setSource(next);
    if (next === "plans" && jobType === "replacement") {
      setJobType("new");
    }
  };

  function goAddress(addr?: string) {
    const target = (addr ?? value).trim();
    if (!target) return;
    // Remember the entered address right away — even if the run fails
    // later, the user may want to retype/edit it from the dropdown
    // rather than re-typing from scratch.
    pushLocalRecent(target);
    router.push(
      `/estimate?address=${encodeURIComponent(target)}&jobType=${jobType}`,
    );
  }

  async function onUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      // Pre-flight the upload-url handshake so we can surface the actual
      // error string instead of @vercel/blob/client's wrapped message.
      const diag = await fetch("/api/blueprints/upload-url");
      if (!diag.ok) {
        const text = await diag.text();
        console.error("[QuickStart upload preflight] non-200", diag.status, text);
        setError(`Upload service is unhealthy (${diag.status}). ${text}`);
        return;
      }
      const diagJson = (await diag.json()) as {
        ok: boolean;
        env: { BLOB_READ_WRITE_TOKEN: boolean };
        blob?: {
          tokenFound: boolean;
          tokenSourceVar: string | null;
          allBlobEnvNames: string[];
        };
        clerk: { signedIn: boolean; error: string | null };
        db: { ok: boolean; error: string | null };
      };
      if (!diagJson.clerk.signedIn) {
        setError("Not signed in. Refresh and sign in again.");
        return;
      }
      if (!diagJson.db.ok) {
        setError(
          `Database is unreachable: ${diagJson.db.error ?? "unknown"}. Wait 5s and retry.`,
        );
        return;
      }
      const blobOk =
        diagJson.blob?.tokenFound ?? diagJson.env.BLOB_READ_WRITE_TOKEN;

      // Multipart fallback when Blob isn't configured: anything under
      // ~4 MB can go straight through Vercel's serverless body limit
      // via /api/blueprints (multipart). The contractor can keep
      // analyzing small plans while Blob is being sorted out.
      const MULTIPART_LIMIT = 4 * 1024 * 1024;
      const useMultipart = !blobOk;

      if (useMultipart && file.size > MULTIPART_LIMIT) {
        const attached =
          diagJson.blob?.allBlobEnvNames?.join(", ") || "none";
        setError(
          `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB and Vercel Blob isn't connected, so the 4 MB fallback can't carry it. Either (a) compress / split the PDF under 4 MB, or (b) add BLOB_READ_WRITE_TOKEN in Vercel. Currently attached BLOB vars: ${attached}.`,
        );
        return;
      }

      let res: Response;
      if (useMultipart) {
        // Direct multipart upload (no Blob). Stays under Vercel's 4.5 MB
        // serverless body limit — server-side /api/blueprints handles it.
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch("/api/blueprints", { method: "POST", body: fd });
      } else {
        // Blob path — direct browser → Vercel Blob → /api/blueprints with URL.
        const blob = await upload(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/blueprints/upload-url",
        });
        res = await fetch("/api/blueprints", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            blobUrl: blob.url,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Plan analysis failed");
        return;
      }
      router.push(`/estimate?planId=${data.id}&jobType=${jobType}`);
    } catch (e) {
      console.error("[QuickStart upload] threw", e);
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function pickFile(f: File) {
    setFile(f);
    setError(null);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-2xl border border-accent-200/60 bg-gradient-to-br from-accent-50 via-white to-sky-50 p-6 shadow-elevated"
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-accent-300/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-10 left-1/3 h-32 w-32 rounded-full bg-sky-300/30 blur-3xl" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent-400/50 to-transparent" />

      <div className="relative">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-accent-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-accent-700 shadow-sm backdrop-blur">
          <Sparkles className="h-3 w-3" />
          New estimate
          <span className="ml-1 inline-flex items-center rounded-md bg-accent-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-accent-800">
            AI
          </span>
        </div>
        <h2 className="font-display mt-4 text-balance text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">
          {source === "address"
            ? "Type one address. Get an AI takeoff."
            : "Upload construction plans. Get a gutter layout."}
        </h2>
        <p className="mt-1 max-w-xl text-sm text-zinc-600">
          {source === "address"
            ? "Eaves, downspouts, corners, waste — all auto-measured from aerial imagery in under a minute."
            : "Drop a roof plan PDF or image. Claude reads it, classifies every eave vs rake, and builds the layout you can edit and send."}
        </p>

        {/* Source + Job-type toggles */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <SegmentedToggle
            label="Source"
            value={source}
            options={[
              { value: "address", label: "Address", Icon: MapPin },
              { value: "plans", label: "Construction plans", Icon: FileUp },
            ]}
            onChange={(v) => onSourceChange(v as Source)}
          />
          <SegmentedToggle
            label="Job"
            value={jobType}
            options={[
              { value: "replacement", label: "Replacement", Icon: Hammer },
              { value: "new", label: "New construction", Icon: Home },
            ]}
            onChange={(v) => setJobType(v as JobType)}
          />
        </div>

        {/* Input area swaps based on source */}
        {source === "address" ? (
          <div className="relative">
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
              className={cn(
                "mt-4 flex h-14 items-center gap-2 rounded-2xl border bg-white pl-4 pr-2 transition",
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

            {showDropdown && (
              <ul
                role="listbox"
                className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-80 overflow-auto rounded-2xl border border-zinc-200 bg-white py-1.5 shadow-elevated"
              >
                <li className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
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
        ) : (
          <div className="mt-4 space-y-3">
            {!file ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-accent-300 bg-white/60 px-6 py-7 text-sm text-zinc-600 transition hover:border-accent-500 hover:bg-white"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-100 text-accent-700">
                  <Upload className="h-5 w-5" />
                </div>
                <div className="text-left">
                  <div className="font-semibold text-zinc-900">
                    Drop a plan, or click to choose
                  </div>
                  <div className="text-xs text-zinc-500">
                    PDF (up to 100 pages) or PNG / JPG · up to 32 MB
                  </div>
                </div>
              </button>
            ) : (
              <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-100 text-accent-700">
                  <FileUp className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-900">
                    {file.name}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {(file.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  disabled={uploading}
                  className="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
                  aria-label="Remove file"
                >
                  <X className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={onUpload}
                  disabled={uploading}
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-accent-600 px-4 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-60 active:translate-y-px"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {uploading ? "Analyzing…" : "Analyze with AI"}
                  {!uploading && <ArrowRight className="h-4 w-4" />}
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
              }}
              className="hidden"
            />
            {uploading && (
              <p className="text-xs italic text-zinc-500">
                Claude usually takes 30–60 seconds — finds the roof plan,
                classifies every edge, returns the gutter layout.
              </p>
            )}
            {error && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {error}
              </p>
            )}
          </div>
        )}

        {/* Sample addresses only in address mode */}
        {source === "address" && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>Try:</span>
            {[
              "1247 Maple Ridge Drive, Austin, TX",
              "82 Lakeshore Ave, Oakland, CA",
            ].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => goAddress(s)}
                className="rounded-full border border-zinc-200 bg-white/70 px-2.5 py-1 text-zinc-600 transition hover:border-accent-400 hover:text-accent-700"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline segmented control                                          */
/*                                                                    */
/*  Lightweight 2-option pill that sits above the input. Inline       */
/*  rather than a separate ui/segmented component because it's used   */
/*  twice and has tight visual coupling to the surrounding card.      */
/* ------------------------------------------------------------------ */
function SegmentedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: {
    value: T;
    label: string;
    Icon: typeof MapPin;
  }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-2 text-xs">
      <span className="font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <div className="inline-flex rounded-full border border-zinc-200 bg-white/80 p-0.5 shadow-sm">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium transition",
                active
                  ? "bg-accent-600 text-white shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900",
              )}
            >
              <opt.Icon className="h-3.5 w-3.5" />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
