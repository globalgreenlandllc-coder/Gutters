"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { upload } from "@vercel/blob/client";
import { Upload, FileText, Loader2, Sparkles, X, Zap } from "lucide-react";
import { fadeInUp } from "@/lib/motion";
import { useSession } from "@/lib/auth-mock";

/** Copy-only stage labels for the analyzing strip. Purely visual — the
 *  upload/analyze flow doesn't report progress, so we pace expectations
 *  on a timer and park on the last stage until the redirect. */
const ANALYZE_STAGES = [
  "Uploading plan",
  "Reading the plan",
  "Classifying edges",
  "Drawing the layout",
];

export default function BlueprintUploader() {
  const router = useRouter();
  const { session } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Visual-only ticker for the analyzing strip (see ANALYZE_STAGES).
  const [stageIdx, setStageIdx] = useState(0);

  // Blueprint analyses are what credits meter (address estimates are
  // free). Client-side courtesy gate — the server enforces the same
  // check with a 402 on POST /api/blueprints.
  const isAdmin = session?.user.role === "SUPER_ADMIN";
  const creditsRemaining = session
    ? Math.max(
        session.credits.included + session.credits.bonus - session.credits.used,
        0,
      )
    : null;
  const outOfCredits = !isAdmin && creditsRemaining === 0;

  useEffect(() => {
    if (!uploading) {
      setStageIdx(0);
      return;
    }
    const id = setInterval(
      () => setStageIdx((s) => Math.min(s + 1, ANALYZE_STAGES.length - 1)),
      12_000,
    );
    return () => clearInterval(id);
  }, [uploading]);

  const pickFile = useCallback((f: File) => {
    setFile(f);
    setError(null);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) pickFile(f);
    },
    [pickFile],
  );

  const onAnalyze = async () => {
    if (!file || outOfCredits) return;
    setUploading(true);
    setError(null);
    try {
      // Probe whether Vercel Blob is configured. When it isn't, we fall
      // back to multipart upload through Vercel's 4.5 MB serverless body
      // limit so small plans can still be analyzed.
      const diag = await fetch("/api/blueprints/upload-url");
      const diagJson = diag.ok
        ? ((await diag.json()) as {
            blob?: {
              tokenFound: boolean;
              allBlobEnvNames: string[];
            };
            env: { BLOB_READ_WRITE_TOKEN: boolean };
          })
        : null;
      const blobOk =
        diagJson?.blob?.tokenFound ?? diagJson?.env.BLOB_READ_WRITE_TOKEN ?? false;

      const MULTIPART_LIMIT = 4 * 1024 * 1024;
      if (!blobOk && file.size > MULTIPART_LIMIT) {
        const attached =
          diagJson?.blob?.allBlobEnvNames?.join(", ") || "none";
        setError(
          `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB and Vercel Blob isn't connected, so the 4 MB fallback can't carry it. Compress / split the PDF, or add BLOB_READ_WRITE_TOKEN. Currently attached BLOB vars: ${attached}.`,
        );
        return;
      }

      let res: Response;
      if (blobOk) {
        // PRIMARY: presigned-URL flow. We POST {filename,mimeType} to
        // /api/blueprints/presign, the server uses issueSignedToken +
        // presignUrl to mint a URL, and we do a single plain-fetch PUT
        // to it. No @vercel/blob/client SDK involved, so there's zero
        // chance of the old code routing to vercel.com/api/blob/mpu.
        let blobUrl: string | null = null;
        try {
          const presignRes = await fetch("/api/blueprints/presign", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
            }),
          });
          if (!presignRes.ok) {
            const errBody = await presignRes.json().catch(() => ({}));
            throw new Error(
              errBody?.error ?? `presign HTTP ${presignRes.status}`,
            );
          }
          const { presignedUrl, pathname } = (await presignRes.json()) as {
            presignedUrl: string;
            pathname: string;
          };
          const putRes = await fetch(presignedUrl, {
            method: "PUT",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          });
          if (!putRes.ok) {
            throw new Error(`Blob PUT HTTP ${putRes.status}`);
          }
          // Public blob URLs are derived from the store ID and pathname.
          // The presigned URL response doesn't include the canonical
          // public URL directly — we read it from the PUT response
          // headers when present, otherwise reconstruct from the
          // signed URL's host + pathname.
          const headerUrl = putRes.headers.get("location");
          const fromPresign = new URL(presignedUrl);
          blobUrl =
            headerUrl ??
            `https://${fromPresign.host.replace("blob.vercel-storage.com", "public.blob.vercel-storage.com")}/${pathname}`;
        } catch (presignErr) {
          console.warn(
            "[BlueprintUploader] presigned-URL path failed, trying SDK upload()",
            presignErr,
          );
        }

        if (blobUrl) {
          res = await fetch("/api/blueprints", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              blobUrl,
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            setError(data.error ?? "Analysis failed");
            return;
          }
          router.push(`/estimate?planId=${data.id}`);
          return;
        }

        // FALLBACK: SDK upload() — only runs if the presign path threw.
        let blob;
        try {
          blob = await upload(file.name, file, {
            access: "public",
            handleUploadUrl: "/api/blueprints/upload-url",
            multipart: false,
          });
        } catch (blobErr) {
          console.error("[BlueprintUploader] Blob direct upload failed", blobErr);
          const message =
            blobErr instanceof Error ? blobErr.message : "Upload failed";
          // Surface the request URL when present — CORS failures don't
          // include it in the Error message but Vercel SDK errors often
          // carry a `cause` with the offending Response.
          const cause =
            blobErr instanceof Error && "cause" in blobErr
              ? (blobErr as { cause?: unknown }).cause
              : undefined;
          if (cause) console.error("[BlueprintUploader] cause:", cause);
          // Tag the error explicitly so we can spot "still going to mpu"
          // failures even when the browser strips the URL from the message.
          const looksLikeCors =
            /CORS|Access-Control|opaque|Failed to fetch/i.test(message);
          if (looksLikeCors) {
            console.warn(
              "[BlueprintUploader] CORS failure — verify the latest deploy is live and hard-refresh (Cmd+Shift+R). If the request URL ends with /mpu, multipart:false isn't taking effect.",
            );
          }
          // Token-expiry retry: the upload-url route now mints 5-minute
          // tokens (was 60 s), but if a token still expires mid-upload
          // we retry once before surfacing the error. A second attempt
          // gets a fresh token and almost always succeeds.
          const expired = /token has expired|expired/i.test(message);
          if (expired) {
            try {
              const retry = await upload(file.name, file, {
                access: "public",
                handleUploadUrl: "/api/blueprints/upload-url",
                multipart: false,
              });
              res = await fetch("/api/blueprints", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  blobUrl: retry.url,
                  filename: file.name,
                  mimeType: file.type || "application/octet-stream",
                }),
              });
              const retryData = await res.json();
              if (!res.ok) {
                setError(retryData.error ?? "Analysis failed");
                return;
              }
              router.push(`/estimate?planId=${retryData.id}`);
              return;
            } catch (retryErr) {
              const m2 =
                retryErr instanceof Error ? retryErr.message : "Upload failed";
              setError(
                `Vercel Blob upload failed even after a token refresh: ${m2}. Check your network and try again.`,
              );
              return;
            }
          }
          if (file.size <= 4 * 1024 * 1024) {
            const fd = new FormData();
            fd.append("file", file);
            res = await fetch("/api/blueprints", { method: "POST", body: fd });
            const data = await res.json();
            if (!res.ok) {
              setError(data.error ?? "Analysis failed");
              return;
            }
            router.push(`/estimate?planId=${data.id}`);
            return;
          }
          setError(
            `Direct upload to Vercel Blob failed: ${message}. File is ${(file.size / 1024 / 1024).toFixed(1)} MB; Vercel's serverless body limit caps the fallback at 4 MB. Try compressing the PDF, or contact support if Blob keeps rejecting.`,
          );
          return;
        }
        res = await fetch("/api/blueprints", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            blobUrl: blob.url,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch("/api/blueprints", { method: "POST", body: fd });
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Analysis failed");
        return;
      }
      // Successful analyses flow into the unified estimate view — same
      // canvas + save/send pipeline as address-based estimates.
      router.push(`/estimate?planId=${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // Out of blueprint credits: swap the dropzone for an upgrade card —
  // no point picking a file the server will 402.
  if (outOfCredits) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
            <Zap className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-900">
              You&rsquo;re out of blueprint credits
            </div>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              Each blueprint analysis uses one credit. Upgrade to Pro for a
              monthly allowance, or buy a credit pack — satellite address
              estimates stay free either way.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link
                href="/dashboard/settings"
                className="transition-smooth ring-focus press-scale inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent-600 px-3.5 text-[13px] font-semibold text-white shadow-sm hover:bg-accent-700"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Upgrade or top up
              </Link>
              <Link
                href="/dashboard/proposals/new"
                className="transition-smooth ring-focus inline-flex h-9 items-center rounded-lg border border-zinc-200 bg-white px-3.5 text-[13px] font-medium text-zinc-700 hover:border-zinc-300 hover:text-zinc-900"
              >
                Run a free address estimate
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        className={`group relative cursor-pointer rounded-2xl border-2 border-dashed p-8 transition-smooth sm:p-10 ${
          dragOver
            ? "border-accent-500 bg-accent-50/70 ring-4 ring-accent-500/10"
            : "border-zinc-200 bg-zinc-50/50 hover:border-accent-300 hover:bg-accent-50/40"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
          }}
          className="hidden"
        />
        <div className="flex flex-col items-center text-center">
          <div
            className={`bg-cta-gradient mb-4 rounded-2xl p-3 text-white shadow-glow transition-transform duration-200 motion-reduce:transition-none group-hover:-translate-y-0.5 group-hover:scale-105 ${
              dragOver ? "-translate-y-0.5 scale-110" : ""
            }`}
          >
            <Upload size={22} />
          </div>
          <div className="mb-1 text-lg font-semibold tracking-tight text-zinc-900">
            Drop construction plans here
          </div>
          <div className="max-w-md text-sm leading-relaxed text-zinc-500">
            PDF (multi-page OK) or a single image of the roof plan. Claude
            reads the plan, identifies eaves vs rakes, and returns a gutter
            layout you can drop into a proposal.
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {["PDF · up to 100 pages", "PNG / JPG", "≤ 50 MB"].map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-500"
              >
                {chip}
              </span>
            ))}
          </div>
          {!isAdmin && creditsRemaining !== null && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-accent-200 bg-accent-50 px-2.5 py-0.5 text-[11px] font-medium text-accent-700">
              <Sparkles className="h-3 w-3" />
              Uses 1 blueprint credit · {creditsRemaining} left
            </div>
          )}
          {/* Build marker — if you don't see "v2" on Vercel prod, the
              new code hasn't deployed yet. Bump this string whenever
              there's a stale-build question to verify. */}
          <div className="mt-1 text-[10px] text-zinc-400 opacity-70">
            uploader v3 · presigned-URL · 15-min token
          </div>
        </div>
      </div>

      {file && (
        <motion.div
          initial={reduce ? false : "hidden"}
          animate="visible"
          variants={fadeInUp}
          className="surface flex items-center gap-3 px-4 py-3"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200/70">
            <FileText size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="truncate text-sm font-medium text-zinc-900">
              {file.name}
            </div>
            <div className="text-xs tabular-nums text-zinc-500">
              {(file.size / 1024).toFixed(0)} KB
            </div>
          </div>
          <button
            onClick={() => setFile(null)}
            className="ring-focus press-scale rounded-lg p-1.5 text-zinc-400 transition-smooth hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Remove file"
            disabled={uploading}
          >
            <X size={16} />
          </button>
          <button
            onClick={onAnalyze}
            disabled={uploading}
            className="bg-cta-gradient ring-focus press-scale ![transition:transform_150ms_ease,box-shadow_200ms_ease,opacity_150ms_ease] motion-reduce:![transition:none] inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13px] font-semibold text-white shadow-sm hover:shadow-glow disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
          >
            {uploading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Analyzing…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                Analyze with AI
              </>
            )}
          </button>
        </motion.div>
      )}

      {uploading && (
        <motion.div
          initial={reduce ? false : "hidden"}
          animate="visible"
          variants={fadeInUp}
          className="surface px-4 py-3.5"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="microlabel text-accent-700">Analyzing plan</span>
            <span className="text-xs tabular-nums text-zinc-400">
              usually 30–60s
            </span>
          </div>
          <div className="skeleton mt-2.5 h-1.5 w-full rounded-full" />
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            {ANALYZE_STAGES.map((stage, i) => (
              <span key={stage} className="flex items-center gap-x-2">
                {i > 0 && (
                  <span aria-hidden className="text-zinc-300">
                    →
                  </span>
                )}
                <span
                  className={`transition-smooth ${
                    i === stageIdx
                      ? "font-semibold text-accent-700"
                      : i < stageIdx
                        ? "text-zinc-500"
                        : "text-zinc-400"
                  }`}
                >
                  {stage}
                </span>
              </span>
            ))}
          </div>
        </motion.div>
      )}

      {error && (
        <motion.div
          initial={reduce ? false : "hidden"}
          animate="visible"
          variants={fadeInUp}
          className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </motion.div>
      )}
    </div>
  );
}
