"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  resetPromptTemplate,
  upsertPromptTemplate,
  type PromptRow,
} from "@/app/actions/prompts";

const GROUPS: { category: PromptRow["category"]; title: string; blurb: string }[] =
  [
    {
      category: "address",
      title: "Scan by address",
      blurb:
        "Drives the satellite-image estimate (enter an address → AI traces the gutters).",
    },
    {
      category: "blueprint",
      title: "Scan from blueprints",
      blurb:
        "Drives the PDF-plan estimate (upload construction plans → AI measures the gutters).",
    },
  ];

export function PromptsEditor({ rows }: { rows: PromptRow[] }) {
  return (
    <div className="space-y-8">
      {GROUPS.map((g) => {
        const groupRows = rows.filter((r) => r.category === g.category);
        if (groupRows.length === 0) return null;
        return (
          <section key={g.category}>
            <div className="mb-3">
              <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
                {g.title}
              </h2>
              <p className="text-sm text-zinc-500">{g.blurb}</p>
            </div>
            <div className="space-y-4">
              {groupRows.map((row) => (
                <PromptCard key={row.key} row={row} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PromptCard({ row }: { row: PromptRow }) {
  const [draft, setDraft] = useState(row.content);
  // Baseline = last value persisted to the DB. Starts at the server value.
  const [saved, setSaved] = useState(row.content);
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<"save" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = draft !== saved;
  const customized = useMemo(
    () => row.isModified || dirty,
    [row.isModified, dirty],
  );

  function save() {
    if (!draft.trim()) {
      setError("Prompt can't be empty.");
      return;
    }
    setError(null);
    setAction("save");
    startTransition(async () => {
      try {
        await upsertPromptTemplate({ key: row.key, content: draft });
        setSaved(draft);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2500);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      } finally {
        setAction(null);
      }
    });
  }

  function reset() {
    if (
      !confirm(
        `Reset "${row.label}" to the version that ships with the app? This replaces the current prompt.`,
      )
    ) {
      return;
    }
    setError(null);
    setAction("reset");
    startTransition(async () => {
      try {
        const res = await resetPromptTemplate(row.key);
        setDraft(res.content);
        setSaved(res.content);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Reset failed");
      } finally {
        setAction(null);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-zinc-900">{row.label}</h3>
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              <Sparkles className="h-3 w-3" />
              {row.model}
            </span>
            {customized && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 ring-1 ring-inset ring-amber-200">
                Customized
              </span>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            {row.description}
          </p>
        </div>
        {row.updatedAt && (
          <div className="text-right text-[11px] text-zinc-400">
            Updated {new Date(row.updatedAt).toLocaleString()}
          </div>
        )}
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={14}
        className="mt-4 w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50/40 p-3 font-mono text-xs leading-relaxed text-zinc-800 outline-none transition focus:border-accent-500 focus:bg-white focus:ring-2 focus:ring-accent-500/15"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold shadow-sm transition disabled:opacity-50",
            "bg-zinc-900 text-white hover:bg-zinc-800",
          )}
        >
          {pending && action === "save" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : justSaved && !dirty ? (
            <Check className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {pending && action === "save"
            ? "Saving…"
            : justSaved && !dirty
              ? "Saved"
              : "Save"}
        </button>

        <button
          type="button"
          onClick={reset}
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 text-sm font-medium text-zinc-700 transition hover:border-zinc-300 disabled:opacity-50"
        >
          {pending && action === "reset" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          Reset to default
        </button>

        {dirty && (
          <span className="text-xs text-amber-700">Unsaved changes</span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-xs text-rose-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
