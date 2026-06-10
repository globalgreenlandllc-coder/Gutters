"use client";

import { useEffect, useState } from "react";

/**
 * Renders a PDF page to a PNG data URL using pdfjs-dist. Returns it
 * via the `onReady` callback so the parent SVG canvas can use it as
 * an <image> href the same way it would a satellite tile.
 *
 * Why a callback instead of returning the data URL: the parent canvas
 * is an SVG with a fixed viewBox, and the image needs to slot into
 * that exact layout via xMidYMid slice. Returning the data URL up to
 * the parent keeps all the layout math co-located with the rest of
 * the SVG markup.
 *
 * pdfjs is loaded dynamically so the ~1 MB worker isn't in the
 * initial bundle for the address-based estimate flow.
 */
export function PlanPdfBackground({
  pdfUrl,
  pageIndex,
  onReady,
  onError,
}: {
  pdfUrl: string;
  pageIndex: number;
  /** Called with a "data:image/png;base64,…" URL ready to drop into an
   *  SVG <image href={…}> tag. */
  onReady: (dataUrl: string) => void;
  /** Called with a short, user-readable error message if rasterization
   *  fails. The parent decides what to render in the failure case
   *  (cartoon scene, blank, error toast). */
  onError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<"loading" | "done" | "error">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Dynamic import — the pdfjs bundle (~800 KB) shouldn't ship to
        // pages that don't need it.
        const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
        // pdfjs needs a Web Worker for parsing. Pin to the same version
        // we installed so the worker and the main bundle always match
        // (mismatched versions throw "API version does not match the
        // Worker version"). jsdelivr serves both modern and legacy
        // .min.mjs paths; we use legacy to match our import above.
        const pdfjsVersion = (pdfjsLib as { version?: string }).version;
        (
          pdfjsLib as { GlobalWorkerOptions: { workerSrc: string } }
        ).GlobalWorkerOptions.workerSrc = pdfjsVersion
          ? `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsVersion}/legacy/build/pdf.worker.min.mjs`
          : "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs";

        const loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          // Big plan sets (20+ pages) need a higher cmap budget.
          cMapPacked: true,
        });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        // Clamp page index to valid range. Claude is told to return
        // 1-based; default to 1 when missing.
        const targetPage = Math.max(1, Math.min(pdf.numPages, pageIndex || 1));
        const page = await pdf.getPage(targetPage);
        if (cancelled) return;

        // Render at 2× the SVG viewBox resolution for crisp display on
        // retina screens; the parent SVG scales it down via
        // preserveAspectRatio. Cap viewport width at 2400 to avoid
        // OOM on giant ARCH-E plan sheets.
        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = Math.min(2400, baseViewport.width * 2);
        const scale = targetWidth / baseViewport.width;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Could not get 2D canvas context");
        }
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        const dataUrl = canvas.toDataURL("image/png");
        onReady(dataUrl);
        setStatus("done");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "PDF rasterization failed";
        console.error("[PlanPdfBackground] rasterize failed:", e);
        setStatus("error");
        onError?.(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfUrl, pageIndex, onReady, onError]);

  // Status is for debugging — parent renders nothing for this component
  // directly; the side-effect is the onReady callback.
  if (status === "loading" || status === "done") return null;
  return null;
}
