"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
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
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/blueprints", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Analysis failed");
        // Still navigate to the failed analysis so the user sees the error
        // and can retry — better UX than dumping them back to the upload form.
        if (data.id) {
          router.push(`/dashboard/blueprints/${data.id}`);
        }
        return;
      }
      router.push(`/dashboard/blueprints/${data.id}`);
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
            Up to 20 MB · PNG / JPG / PDF
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
