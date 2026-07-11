"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { upload } from "@vercel/blob/client";
import { Upload, FileText, Loader2, X } from "lucide-react";

export default function BlueprintUploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!file) return;
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
        className={`relative cursor-pointer rounded-2xl border-2 border-dashed bg-white p-8 transition-all sm:p-12 ${
          dragOver
            ? "border-accent-500 bg-accent-50/60 ring-2 ring-accent-500/30"
            : "border-zinc-300 hover:border-accent-400 hover:ring-2 hover:ring-accent-500/15"
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
          <div className="mb-3 rounded-full bg-accent-50 p-3 text-accent-700 ring-1 ring-accent-200">
            <Upload size={24} />
          </div>
          <div className="mb-1 text-lg font-semibold tracking-tight text-zinc-900">
            Drop construction plans here
          </div>
          <div className="max-w-md text-sm text-zinc-500">
            PDF (multi-page OK) or a single image of the roof plan. Claude
            reads the plan, identifies eaves vs rakes, and returns a gutter
            layout you can drop into a proposal.
          </div>
          <div className="mt-2 text-xs text-zinc-400">
            Up to 50 MB · PDF (up to 100 pages) or PNG / JPG
          </div>
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
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="surface flex items-center gap-3 px-4 py-3"
        >
          <FileText size={20} className="text-zinc-500" />
          <div className="flex-1 min-w-0">
            <div className="truncate text-sm font-medium text-zinc-900">
              {file.name}
            </div>
            <div className="text-xs text-zinc-500">
              {(file.size / 1024).toFixed(0)} KB
            </div>
          </div>
          <button
            onClick={() => setFile(null)}
            className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Remove file"
            disabled={uploading}
          >
            <X size={16} />
          </button>
          <button
            onClick={onAnalyze}
            disabled={uploading}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Analyzing…
              </>
            ) : (
              "Analyze with AI"
            )}
          </button>
        </motion.div>
      )}

      {uploading && (
        <div className="text-xs italic text-zinc-500">
          This usually takes 30–60 seconds. Claude needs to find the roof plan,
          classify every edge, and produce the JSON layout.
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}
    </div>
  );
}
