"use client";

import { Pencil } from "lucide-react";
import type { Proposal } from "@/lib/proposal-mock";
import { Badge } from "@/components/ui/badge";

export function CoverSection({
  proposal,
  onChange,
  readOnly,
}: {
  proposal: Proposal;
  onChange: (next: Proposal) => void;
  readOnly?: boolean;
}) {
  return (
    <section
      data-section="cover"
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Badge>Proposal</Badge>
          <h1 className="font-display mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Gutter replacement at <br className="hidden sm:block" />
            <span className="text-gradient">{proposal.address}</span>
          </h1>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-right text-sm">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Prepared by
          </div>
          <div className="mt-1 font-medium text-zinc-100">
            {proposal.contractor.company}
          </div>
          <div className="text-zinc-400">{proposal.contractor.name}</div>
          <div className="mt-1 text-xs text-zinc-500">
            License {proposal.contractor.license}
          </div>
        </div>
      </div>

      <EditableTextarea
        value={proposal.intro}
        onChange={(v) => onChange({ ...proposal, intro: v })}
        readOnly={readOnly}
        className="mt-6 text-base leading-relaxed text-zinc-300"
      />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Client" value={proposal.client.name} />
        <Stat
          label="Total LF"
          value={`${proposal.measurements.eaveLF} LF`}
        />
        <Stat
          label="Downspouts"
          value={`${proposal.measurements.downspoutCount}`}
        />
        <Stat label="Valid for" value={`${proposal.validDays} days`} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-medium text-zinc-100">
        {value}
      </div>
    </div>
  );
}

function EditableTextarea({
  value,
  onChange,
  readOnly,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  className?: string;
}) {
  if (readOnly) {
    return <p className={className}>{value}</p>;
  }
  return (
    <div className="group relative">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={`${className} w-full resize-none rounded-lg border border-transparent bg-transparent p-2 outline-none transition focus:border-accent-400/30 focus:bg-white/[0.02] group-hover:border-white/10`}
      />
      <Pencil className="pointer-events-none absolute right-2 top-2 h-3.5 w-3.5 text-zinc-600 opacity-0 transition group-hover:opacity-100" />
    </div>
  );
}
