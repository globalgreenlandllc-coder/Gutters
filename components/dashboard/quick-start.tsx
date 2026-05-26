"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { upload } from "@vercel/blob/client";
import {
  ArrowRight,
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

type Source = "address" | "plans";
type JobType = "replacement" | "new";

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
    router.push(
      `/estimate?address=${encodeURIComponent(target)}&jobType=${jobType}`,
    );
  }

  async function onUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      // 1. Direct upload to Vercel Blob — bypasses Vercel's 4.5MB
      //    serverless body limit so real construction PDFs (5-25MB) work.
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/blueprints/upload-url",
      });

      // 2. Tell our analyzer to pick up the file by URL and run Claude.
      const res = await fetch("/api/blueprints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Plan analysis failed");
        return;
      }
      router.push(`/estimate?planId=${data.id}&jobType=${jobType}`);
    } catch (e) {
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goAddress();
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
                    PDF (multi-page OK) or PNG / JPG · up to 20 MB
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
