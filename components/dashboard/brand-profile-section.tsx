"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Building2, Check, Eye, Pencil, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/ui/brand-mark";
import { Button } from "@/components/ui/button";
import {
  defaultProfile,
  useUpdateProfile,
  useProfile,
  type ContractorProfile,
  type LogoTone,
} from "@/lib/auth-mock";
import { cn } from "@/lib/utils";

const TONES: { id: LogoTone; label: string; swatch: string }[] = [
  { id: "emerald", label: "Emerald", swatch: "bg-accent-500" },
  { id: "sky", label: "Sky", swatch: "bg-sky-500" },
  { id: "indigo", label: "Indigo", swatch: "bg-indigo-500" },
  { id: "violet", label: "Violet", swatch: "bg-violet-500" },
  { id: "amber", label: "Amber", swatch: "bg-amber-500" },
  { id: "rose", label: "Rose", swatch: "bg-rose-500" },
  { id: "zinc", label: "Slate", swatch: "bg-zinc-700" },
];

export function BrandProfileSection() {
  const stored = useProfile();
  const updateProfile = useUpdateProfile();
  const [draft, setDraft] = useState<ContractorProfile>(stored);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(stored);
  }, [
    stored.company,
    stored.contractorName,
    stored.email,
    stored.phone,
    stored.license,
    stored.tagline,
    stored.logo.initials,
    stored.logo.tone,
  ]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  function update<K extends keyof ContractorProfile>(
    key: K,
    value: ContractorProfile[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function setLogo<K extends keyof ContractorProfile["logo"]>(
    key: K,
    value: ContractorProfile["logo"][K],
  ) {
    setDraft((d) => ({ ...d, logo: { ...d.logo, [key]: value } }));
  }

  async function save() {
    setSaving(true);
    try {
      await updateProfile(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    const def = defaultProfile();
    setDraft(def);
    setSaving(true);
    try {
      await updateProfile(def);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-50 text-accent-700">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
              Brand & company profile
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Shown on every proposal cover and the homeowner portal.
            </p>
          </div>
        </div>
        <Badge tone={dirty ? "amber" : "accent"}>
          {dirty ? "Unsaved changes" : (
            <>
              <Check className="h-3 w-3" />
              Saved
            </>
          )}
        </Badge>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Company name"
              value={draft.company}
              onChange={(v) => update("company", v)}
            />
            <Field
              label="Contractor name"
              value={draft.contractorName}
              onChange={(v) => update("contractorName", v)}
            />
            <Field
              label="Phone"
              value={draft.phone}
              onChange={(v) => update("phone", v)}
            />
            <Field
              label="Email"
              type="email"
              value={draft.email}
              onChange={(v) => update("email", v)}
            />
            <Field
              label="License #"
              value={draft.license}
              onChange={(v) => update("license", v)}
            />
            <Field
              label="Logo monogram"
              value={draft.logo.initials}
              onChange={(v) =>
                setLogo("initials", v.slice(0, 3).toUpperCase())
              }
              hint="1–3 letters"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
              Tagline
            </label>
            <textarea
              value={draft.tagline}
              onChange={(e) => update("tagline", e.target.value)}
              rows={2}
              maxLength={120}
              className="w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/15"
            />
            <div className="mt-1 text-right text-[11px] text-zinc-400">
              {draft.tagline.length}/120
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-zinc-500">
              Logo color
            </label>
            <div className="flex flex-wrap gap-1.5">
              {TONES.map((t) => {
                const selected = draft.logo.tone === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setLogo("tone", t.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs transition",
                      selected
                        ? "border-zinc-300 bg-zinc-50 text-zinc-900"
                        : "border-zinc-200 text-zinc-600 hover:border-zinc-300",
                    )}
                  >
                    <span className={cn("h-3.5 w-3.5 rounded-full", t.swatch)} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={!dirty || saving}>
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={saving}>
              Reset to defaults
            </Button>
          </div>
        </div>

        <ProposalPreview draft={draft} />
      </div>
    </section>
  );
}

function ProposalPreview({ draft }: { draft: ContractorProfile }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50/40 p-4"
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium uppercase tracking-wider text-zinc-500">
          Live preview
        </span>
        <span className="inline-flex items-center gap-1 text-zinc-500">
          <Eye className="h-3 w-3" />
          Proposal header
        </span>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <BrandMark
            initials={draft.logo.initials || "GU"}
            tone={draft.logo.tone}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-zinc-900">
              {draft.company || "Your company"}
            </div>
            <div className="truncate text-xs text-zinc-500">
              {draft.contractorName || "Contractor"} · License {draft.license || "—"}
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-zinc-500">
              {draft.tagline}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500">
          <span>{draft.phone}</span>
          <span>·</span>
          <span className="truncate">{draft.email}</span>
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-zinc-200 p-3 text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <Pencil className="h-3 w-3" />
          Changes flow into <span className="font-medium text-zinc-700">/proposal</span>{" "}
          and <span className="font-medium text-zinc-700">/p/[token]</span> immediately.
        </div>
      </div>
    </motion.div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/15"
      />
      {hint && (
        <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>
      )}
    </label>
  );
}
