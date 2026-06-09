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
        // Single-PUT upload directly to *.public.blob.vercel-storage.com,
        // which has CORS configured for any origin. The `multipart: true`
        // path goes through vercel.com/api/blob/mpu — that endpoint does
        // NOT send Access-Control-Allow-Origin for many custom Vercel
        // origins (we saw it fail from gutters-nu.vercel.app with
        // "blocked by CORS policy"). Direct uploads work up to ~5 GB
        // per request which is plenty above our 50 MB ceiling.
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
        className={`relative cursor-pointer rounded-2xl border-2 border-dashed p-8 sm:p-12 transition-colors ${
          dragOver
            ? "border-emerald-500/70 bg-emerald-500/5"
            : "border-slate-700 bg-slate-900/40 hover:border-slate-600 hover:bg-slate-900/60"
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
          <div className="rounded-full bg-emerald-500/10 p-3 ring-1 ring-emerald-500/30 text-emerald-300 mb-3">
            <Upload size={24} />
          </div>
          <div className="text-white font-semibold text-lg mb-1">
            Drop construction plans here
          </div>
          <div className="text-slate-400 text-sm max-w-md">
            PDF (multi-page OK) or a single image of the roof plan. Claude
            reads the plan, identifies eaves vs rakes, and returns a gutter
            layout you can drop into a proposal.
          </div>
          <div className="text-slate-500 text-xs mt-2">
            Up to 50 MB · PDF (up to 100 pages) or PNG / JPG
          </div>
        </div>
      </div>

      {file && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3"
        >
          <FileText size={20} className="text-slate-300" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-white font-medium truncate">
              {file.name}
            </div>
            <div className="text-xs text-slate-500">
              {(file.size / 1024).toFixed(0)} KB
            </div>
          </div>
          <button
            onClick={() => setFile(null)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            aria-label="Remove file"
            disabled={uploading}
          >
            <X size={16} />
          </button>
          <button
            onClick={onAnalyze}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition"
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
        <div className="text-xs text-slate-500 italic">
          This usually takes 30–60 seconds. Claude needs to find the roof plan,
          classify every edge, and produce the JSON layout.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}
