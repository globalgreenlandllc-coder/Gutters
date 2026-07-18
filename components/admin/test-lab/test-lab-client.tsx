"use client";

/**
 * Admin accuracy lab — the whole interactive surface.
 *
 * Flow: run an address → the engine's trace opens in the SAME editing
 * canvas contractors use → the admin corrects (or approves) it → every
 * change is live-classified and tag-able ("this was a shed") → finalize
 * stores the ground truth + the lab's read on WHY each change happened →
 * Re-test replays stored runs through the current engine and scores them
 * against the ground truth, so engine work shows up as a percentage.
 */

import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  ImageDown,
  Loader2,
  Play,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";
import { AerialCanvas } from "@/components/estimate/aerial-canvas";
import type { Downspout, EditableLine } from "@/lib/types";
import { computeLabDiff, type LabDiff } from "@/lib/test-lab/diff";
import { LAB_TAGS, type LabTag, type LabTagId } from "@/lib/test-lab/feedback";
import {
  deleteLabRun,
  finalizeLabRun,
  getLabRun,
  listLabRuns,
  retestLabRun,
  runLabEstimate,
  type LabAggregate,
  type LabRunDetail,
  type LabRunSummary,
} from "@/app/actions/test-lab";

/* ------------------------------------------------------------------ */
/* Small UI atoms                                                      */
/* ------------------------------------------------------------------ */

function StatusBadge({ status }: { status: LabRunSummary["status"] }) {
  const map = {
    PENDING: "bg-amber-50 text-amber-700 border-amber-200",
    APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
    CORRECTED: "bg-accent-50 text-accent-800 border-accent-200",
  } as const;
  const label = { PENDING: "Pending", APPROVED: "Approved", CORRECTED: "Corrected" }[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${map[status]}`}>
      {label}
    </span>
  );
}

function ScoreBadge({ score }: { score: { scorePct: number; clean: boolean } | null }) {
  if (!score) return <span className="text-xs text-zinc-400">—</span>;
  const tone =
    score.scorePct >= 97
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : score.scorePct >= 85
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-rose-50 text-rose-700 border-rose-200";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {score.scorePct}%{score.clean ? " · clean" : ""}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Export PNG — aerial + corrected trace, no macOS screenshots needed  */
/* ------------------------------------------------------------------ */

const VIEW_W = 900;
const VIEW_H = 580;

function exportRunPng(args: {
  address: string;
  aerialUrl: string | null;
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
}) {
  const scale = 2; // 2× for a crisp file
  const cv = document.createElement("canvas");
  cv.width = VIEW_W * scale;
  cv.height = VIEW_H * scale;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);

  const drawOverlay = () => {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Rakes: gray dashed (no-gutter edges)
    ctx.strokeStyle = "rgba(244,244,245,0.75)";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    for (const r of args.rakes) {
      ctx.beginPath();
      r.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    // Eaves: solid cyan (the priced gutter)
    ctx.setLineDash([]);
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 3;
    for (const e of args.eaves) {
      ctx.beginPath();
      e.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    // Downspouts: magenta dots
    ctx.fillStyle = "#e879f9";
    for (const d of args.downspouts) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    const a = document.createElement("a");
    a.download = `${args.address.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-takeoff.png`;
    a.href = cv.toDataURL("image/png");
    a.click();
  };

  if (args.aerialUrl) {
    const img = new Image();
    img.onload = () => {
      // Mirror the canvas's COVER fit of the aerial into the 900×580 viewBox.
      const s = Math.max(VIEW_W / img.width, VIEW_H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.drawImage(img, (VIEW_W - w) / 2, (VIEW_H - h) / 2, w, h);
      drawOverlay();
    };
    img.src = args.aerialUrl;
  } else {
    ctx.fillStyle = "#09090b";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawOverlay();
  }
}

/* ------------------------------------------------------------------ */
/* Changes panel — live diff + one-tap failure tags                    */
/* ------------------------------------------------------------------ */

const ACTION_LABEL: Record<string, string> = {
  deleted: "Deleted",
  added: "Added",
  moved: "Moved",
  reclassified: "Eave⇄gable",
};

function ChangesPanel({
  diff,
  tags,
  onTag,
}: {
  diff: LabDiff;
  tags: Record<string, { tag: LabTagId; note?: string }>;
  onTag: (key: string, tag: LabTagId | null, note?: string) => void;
}) {
  const rows = [
    ...diff.changes.map((c) => ({
      key: c.key,
      label: `${ACTION_LABEL[c.action]} ${c.geo} · ${Math.round(c.lengthFt)} LF${
        c.action === "moved" && c.maxShiftFt ? ` (moved ${c.maxShiftFt.toFixed(1)} ft)` : ""
      }`,
      taggable: c.action !== "reclassified",
    })),
    ...diff.downspoutChanges.map((c) => ({
      key: c.key,
      label: `${ACTION_LABEL[c.action]} downspout${c.shiftFt ? ` (${c.shiftFt.toFixed(1)} ft)` : ""}`,
      taggable: c.action === "deleted",
    })),
  ];

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 text-sm text-emerald-800">
        No changes yet — if the trace is right, hit <strong>Approve as-is</strong>.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
        {rows.length} change{rows.length === 1 ? "" : "s"} · engine {diff.eaveLFBefore} LF → yours{" "}
        {diff.eaveLFAfter} LF
      </div>
      {rows.map((row) => {
        const current = tags[row.key];
        return (
          <div key={row.key} className="rounded-xl border border-zinc-200 bg-white p-2.5">
            <div className="text-sm font-medium text-zinc-800">{row.label}</div>
            {row.taggable && (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {LAB_TAGS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onTag(row.key, current?.tag === t.id ? null : t.id, current?.note)}
                      className={`transition-smooth press-scale rounded-full border px-2 py-0.5 text-xs ${
                        current?.tag === t.id
                          ? "border-accent-600 bg-accent-600 text-white"
                          : "border-zinc-200 bg-white text-zinc-600 hover:border-accent-300 hover:text-accent-800"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                {current?.tag === "other" && (
                  <input
                    type="text"
                    placeholder="What was it?"
                    defaultValue={current.note ?? ""}
                    onBlur={(e) => onTag(row.key, "other", e.target.value || undefined)}
                    className="input mt-1.5 h-8 w-full text-xs"
                  />
                )}
              </>
            )}
          </div>
        );
      })}
      <p className="text-xs leading-relaxed text-zinc-400">
        Tags are optional but gold — they tell the engine <em>why</em> a line was wrong, not just
        that it was.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback panel — "here's my read on why"                            */
/* ------------------------------------------------------------------ */

function FeedbackPanel({
  feedback,
}: {
  feedback: { headline: string; items: { title: string; detail: string }[] };
}) {
  return (
    <div className="space-y-2.5 rounded-xl border border-accent-200 bg-accent-50/50 p-3">
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent-700" />
        <div className="text-sm font-semibold text-accent-900">{feedback.headline}</div>
      </div>
      {feedback.items.map((item, i) => (
        <div key={i} className="rounded-lg bg-white/70 px-2.5 py-2">
          <div className="text-xs font-semibold text-zinc-800">{item.title}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-zinc-600">{item.detail}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The lab                                                             */
/* ------------------------------------------------------------------ */

type RetestRow = {
  id: string;
  address: string;
  ok: boolean;
  scorePct?: number;
  prevPct?: number | null;
  clean?: boolean;
  error?: string;
};

export function TestLabClient({
  initialRuns,
  initialAggregate,
}: {
  initialRuns: LabRunSummary[];
  initialAggregate: LabAggregate;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [aggregate, setAggregate] = useState(initialAggregate);

  const [address, setAddress] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [active, setActive] = useState<LabRunDetail | null>(null);
  const [eaves, setEaves] = useState<EditableLine[]>([]);
  const [rakes, setRakes] = useState<EditableLine[]>([]);
  const [downspouts, setDownspouts] = useState<Downspout[]>([]);
  const [suggested, setSuggested] = useState<EditableLine[]>([]);
  const [tags, setTags] = useState<Record<string, { tag: LabTagId; note?: string }>>({});
  const [finalizing, setFinalizing] = useState(false);
  const [feedback, setFeedback] = useState<{
    headline: string;
    items: { title: string; detail: string }[];
  } | null>(null);

  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [retesting, setRetesting] = useState(false);
  const [retestProgress, setRetestProgress] = useState<{ done: number; total: number } | null>(null);
  const [retestReport, setRetestReport] = useState<RetestRow[] | null>(null);

  const openEditor = (run: LabRunDetail) => {
    setActive(run);
    const geo = run.corrected ?? {
      eaves: run.engine.eaves,
      rakes: run.engine.rakes,
      downspouts: run.engine.downspouts,
    };
    setEaves(geo.eaves ?? []);
    setRakes(geo.rakes ?? []);
    setDownspouts(geo.downspouts ?? []);
    setSuggested(run.corrected ? [] : (run.engine.suggestedEaves ?? []));
    setTags(Object.fromEntries((run.tags ?? []).map((t) => [t.key, { tag: t.tag, note: t.note }])));
    const storedFeedback = (run.diff as { feedback?: typeof feedback } | null)?.feedback ?? null;
    setFeedback(storedFeedback ?? null);
  };

  const refreshList = async () => {
    const data = await listLabRuns();
    setRuns(data.runs);
    setAggregate(data.aggregate);
  };

  const liveDiff = useMemo<LabDiff | null>(() => {
    if (!active) return null;
    return computeLabDiff(
      {
        eaves: active.engine.eaves ?? [],
        rakes: active.engine.rakes ?? [],
        downspouts: active.engine.downspouts ?? [],
      },
      { eaves, rakes, downspouts },
      active.canvasPxPerFt,
    );
  }, [active, eaves, rakes, downspouts]);

  const handleRun = async () => {
    if (!address.trim() || running) return;
    setRunning(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await runLabEstimate(address.trim());
      if (!res.ok) {
        setError(res.error);
      } else {
        openEditor(res.run);
        setAddress("");
        await refreshList();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setRunning(false);
    }
  };

  const handleFinalize = async () => {
    if (!active || finalizing) return;
    setFinalizing(true);
    try {
      const tagList: LabTag[] = Object.entries(tags).map(([key, v]) => ({
        key,
        tag: v.tag,
        note: v.note,
      }));
      const res = await finalizeLabRun({
        id: active.id,
        corrected: { eaves, rakes, downspouts },
        tags: tagList,
      });
      if (res.ok) {
        setFeedback(res.feedback as typeof feedback);
        setActive({ ...active, status: res.status, corrected: { eaves, rakes, downspouts } });
        await refreshList();
      } else {
        setError(res.error);
      }
    } finally {
      setFinalizing(false);
    }
  };

  const handleOpen = async (id: string) => {
    setBusyRun(id);
    try {
      const res = await getLabRun(id);
      if (res.ok) {
        setFeedback(null);
        openEditor(res.run);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } finally {
      setBusyRun(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this lab run and its ground truth?")) return;
    setBusyRun(id);
    try {
      await deleteLabRun(id);
      if (active?.id === id) setActive(null);
      await refreshList();
    } finally {
      setBusyRun(null);
    }
  };

  const handleRetestOne = async (id: string) => {
    setBusyRun(id);
    try {
      const res = await retestLabRun(id);
      if (!res.ok) setError(res.error);
      await refreshList();
    } finally {
      setBusyRun(null);
    }
  };

  const handleExport = async (id: string) => {
    setBusyRun(id);
    try {
      const res = await getLabRun(id);
      if (res.ok) {
        const geo = res.run.corrected ?? {
          eaves: res.run.engine.eaves,
          rakes: res.run.engine.rakes,
          downspouts: res.run.engine.downspouts,
        };
        exportRunPng({
          address: res.run.address,
          aerialUrl: res.run.aerial?.imageDataUrl ?? null,
          eaves: geo.eaves ?? [],
          rakes: geo.rakes ?? [],
          downspouts: geo.downspouts ?? [],
        });
      }
    } finally {
      setBusyRun(null);
    }
  };

  const handleRetestAll = async () => {
    const targets = runs.filter((r) => r.status !== "PENDING" && r.replayable);
    if (targets.length === 0 || retesting) return;
    setRetesting(true);
    setRetestReport(null);
    setRetestProgress({ done: 0, total: targets.length });
    const report: RetestRow[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try {
        const res = await retestLabRun(t.id);
        report.push(
          res.ok
            ? {
                id: t.id,
                address: t.address,
                ok: true,
                scorePct: res.score.scorePct,
                prevPct: res.previous?.scorePct ?? null,
                clean: res.score.clean,
              }
            : { id: t.id, address: t.address, ok: false, error: res.error },
        );
      } catch (e) {
        report.push({
          id: t.id,
          address: t.address,
          ok: false,
          error: e instanceof Error ? e.message : "failed",
        });
      }
      setRetestProgress({ done: i + 1, total: targets.length });
    }
    setRetestReport(report);
    setRetestProgress(null);
    setRetesting(false);
    await refreshList();
  };

  const scored = retestReport?.filter((r) => r.ok) ?? [];
  const retestAvg =
    scored.length > 0
      ? Math.round(scored.reduce((s, r) => s + (r.scorePct ?? 0), 0) / scored.length)
      : null;

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6">
      {/* Scoreboard strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Runs", value: aggregate.total },
          { label: "Pending", value: aggregate.pending },
          { label: "Ground truths", value: aggregate.approved + aggregate.corrected },
          {
            label: "Engine accuracy",
            value: aggregate.avgScorePct != null ? `${aggregate.avgScorePct}%` : "—",
          },
          {
            label: "Clean on re-test",
            value: aggregate.scored > 0 ? `${aggregate.cleanCount}/${aggregate.scored}` : "—",
          },
        ].map((s) => (
          <div key={s.label} className="surface px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">{s.value}</div>
          </div>
        ))}
      </div>

      {/* New run */}
      <div className="surface p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleRun();
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            ref={inputRef}
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Run a test address — e.g. 4318 168th Pl SE, Bothell, WA"
            className="input h-11 flex-1"
            disabled={running}
          />
          <button
            type="submit"
            disabled={running || address.trim().length < 5}
            className="transition-smooth ring-focus press-scale inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-accent-600 px-5 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Engine running…" : "Run engine"}
          </button>
        </form>
        {error && (
          <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}
      </div>

      {/* Active run editor */}
      {active && (
        <div className="surface overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <StatusBadge status={active.status} />
              <div className="text-sm font-semibold text-zinc-900">{active.address}</div>
              {!active.replayable && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                  legacy path — not replayable
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  exportRunPng({
                    address: active.address,
                    aerialUrl: active.aerial?.imageDataUrl ?? null,
                    eaves,
                    rakes,
                    downspouts,
                  })
                }
                className="transition-smooth ring-focus press-scale inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-900"
              >
                <ImageDown className="h-3.5 w-3.5" /> Export PNG
              </button>
              <button
                type="button"
                onClick={() => setActive(null)}
                className="transition-smooth ring-focus press-scale rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900"
                aria-label="Close editor"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0">
              <AerialCanvas
                eaves={eaves}
                rakes={rakes}
                downspouts={downspouts}
                suggestedEaves={suggested}
                onAcceptSuggested={(line) => {
                  setSuggested((s) => s.filter((l) => l.id !== line.id));
                  setEaves((e) => [...e, { ...line, kind: "eave" as const }]);
                }}
                onEavesChange={setEaves}
                onRakesChange={setRakes}
                onDownspoutsChange={setDownspouts}
                aerialImageUrl={active.aerial?.imageDataUrl}
                roofStructure={active.engine.roofStructure ?? undefined}
                pxPerFt={active.canvasPxPerFt}
                magnetPath={active.engine.magnetPath}
                magnetRingCount={active.engine.magnetRingCount}
              />
              {active.notes.length > 0 && (
                <details className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-500">
                    Engine notes ({active.notes.length})
                  </summary>
                  <ul className="mt-1.5 space-y-1 text-xs text-zinc-600">
                    {active.notes.map((n, i) => (
                      <li key={i}>· {n}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            <div className="space-y-3">
              {liveDiff && (
                <ChangesPanel
                  diff={liveDiff}
                  tags={tags}
                  onTag={(key, tag, note) =>
                    setTags((prev) => {
                      const next = { ...prev };
                      if (tag === null) delete next[key];
                      else next[key] = { tag, note };
                      return next;
                    })
                  }
                />
              )}

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={finalizing || !liveDiff}
                  className={`transition-smooth ring-focus press-scale inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                    liveDiff?.isClean
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : "bg-accent-600 hover:bg-accent-700"
                  }`}
                >
                  {finalizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {liveDiff?.isClean ? "Approve as-is (clean pass)" : "Finalize corrections"}
                </button>
                {active.status !== "PENDING" && active.replayable && (
                  <button
                    type="button"
                    onClick={() => void handleRetestOne(active.id)}
                    disabled={busyRun === active.id}
                    className="transition-smooth ring-focus press-scale inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 hover:text-zinc-900 disabled:opacity-50"
                  >
                    {busyRun === active.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-4 w-4" />
                    )}
                    Re-test this roof
                  </button>
                )}
              </div>

              {feedback && <FeedbackPanel feedback={feedback} />}

              {active.lastScore && (
                <div className="rounded-xl border border-zinc-200 bg-white p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      Last re-test
                    </span>
                    <ScoreBadge score={active.lastScore} />
                  </div>
                  <div className="mt-1.5 text-xs text-zinc-600">
                    Precision {Math.round((active.lastScore.eavePrecision ?? 0) * 100)}% · recall{" "}
                    {Math.round((active.lastScore.eaveRecall ?? 0) * 100)}% · LF error{" "}
                    {active.lastScore.lfErrorPct}% · downspouts{" "}
                    {active.lastScore.downspouts.matched}/{active.lastScore.downspouts.truth}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Re-test report */}
      {(retestProgress || retestReport) && (
        <div className="surface p-4">
          {retestProgress ? (
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-accent-700" />
              <div className="text-sm text-zinc-700">
                Replaying stored roofs through the current engine… {retestProgress.done}/
                {retestProgress.total}
              </div>
            </div>
          ) : (
            retestReport && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
                    Re-test report
                  </h2>
                  {retestAvg != null && (
                    <span className="rounded-full bg-accent-50 px-3 py-1 text-sm font-semibold text-accent-800">
                      {retestAvg}% average
                    </span>
                  )}
                  <span className="text-sm text-zinc-500">
                    {scored.filter((r) => r.clean).length} of {scored.length} need no correction
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {retestReport.map((r) => (
                        <tr key={r.id} className="border-t border-zinc-100">
                          <td className="py-1.5 pr-3 text-zinc-800">{r.address}</td>
                          <td className="py-1.5 pr-3">
                            {r.ok ? (
                              <ScoreBadge score={{ scorePct: r.scorePct!, clean: !!r.clean }} />
                            ) : (
                              <span className="text-xs text-rose-600">{r.error}</span>
                            )}
                          </td>
                          <td className="py-1.5 text-xs text-zinc-500">
                            {r.ok && r.prevPct != null && r.scorePct != null && r.scorePct !== r.prevPct && (
                              <span className={r.scorePct > r.prevPct ? "text-emerald-600" : "text-rose-600"}>
                                {r.scorePct > r.prevPct ? "▲" : "▼"} was {r.prevPct}%
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* Runs table */}
      <div className="surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Test library</h2>
          <button
            type="button"
            onClick={() => void handleRetestAll()}
            disabled={retesting || runs.every((r) => r.status === "PENDING" || !r.replayable)}
            className="transition-smooth ring-focus press-scale inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-900 disabled:opacity-50"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${retesting ? "animate-spin" : ""}`} />
            Re-test all
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-400">
            No runs yet — enter an address above to start teaching the engine.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
                  <th className="px-4 py-2.5">Address</th>
                  <th className="px-2 py-2.5">Status</th>
                  <th className="px-2 py-2.5">Engine LF</th>
                  <th className="px-2 py-2.5">Truth LF</th>
                  <th className="px-2 py-2.5">Changes</th>
                  <th className="px-2 py-2.5">Score</th>
                  <th className="px-2 py-2.5">Date</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-50 hover:bg-zinc-50/50">
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => void handleOpen(r.id)}
                        className="text-left font-medium text-accent-800 hover:underline"
                      >
                        {r.address}
                      </button>
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-2 py-2.5 tabular-nums text-zinc-700">
                      {Math.round(r.engineEaveLF)}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums text-zinc-700">
                      {r.correctedEaveLF != null ? Math.round(r.correctedEaveLF) : "—"}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums text-zinc-700">
                      {r.changeCount ?? "—"}
                    </td>
                    <td className="px-2 py-2.5">
                      <ScoreBadge score={r.lastScore} />
                    </td>
                    <td className="px-2 py-2.5 text-xs text-zinc-500">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {r.status !== "PENDING" && r.replayable && (
                          <button
                            type="button"
                            onClick={() => void handleRetestOne(r.id)}
                            disabled={busyRun === r.id || retesting}
                            title="Re-test against ground truth"
                            className="transition-smooth press-scale rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-accent-800 disabled:opacity-40"
                          >
                            {busyRun === r.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCcw className="h-4 w-4" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleExport(r.id)}
                          disabled={busyRun === r.id}
                          title="Export PNG"
                          className="transition-smooth press-scale rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-accent-800 disabled:opacity-40"
                        >
                          <ImageDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(r.id)}
                          disabled={busyRun === r.id}
                          title="Delete run"
                          className="transition-smooth press-scale rounded-lg p-1.5 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
