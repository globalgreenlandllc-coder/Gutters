"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  MapPin,
  Clock,
  User,
  Phone,
  Check,
  X,
  CheckCircle2,
  Loader2,
  Ruler,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WorkerRoof } from "./worker-roof";
import { fmtMoney, fmtWhen, STATUS_META } from "./format";
import { respondToJob, markJobComplete } from "@/app/actions/worker-jobs";
import type { WorkerJobDTO } from "@/lib/worker-dto";

export function WorkerJobDetail({ job }: { job: WorkerJobDTO }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "accept" | "decline" | "complete">(null);
  const [err, setErr] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const m = job.roof?.measurements;

  async function accept() {
    setBusy("accept");
    setErr(null);
    const r = await respondToJob(job.id, "accept");
    setBusy(null);
    if (!r.ok) return setErr(r.reason);
    router.refresh();
  }
  async function decline() {
    setBusy("decline");
    setErr(null);
    const r = await respondToJob(job.id, "decline", reason);
    setBusy(null);
    if (!r.ok) return setErr(r.reason);
    setDeclining(false);
    router.refresh();
  }
  async function complete() {
    setBusy("complete");
    setErr(null);
    const r = await markJobComplete(job.id);
    setBusy(null);
    if (!r.ok) return setErr(r.reason);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <Link href="/worker" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="h-4 w-4" /> All jobs
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_META[job.status].tone}>{STATUS_META[job.status].label}</Badge>
            <span className="text-xs text-zinc-400">{job.kindLabel}</span>
            {job.owner.company && <span className="text-xs text-zinc-400">· from {job.owner.company}</span>}
          </div>
          <h1 className="mt-1.5 text-2xl font-semibold text-ink">{job.title}</h1>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 text-right">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Your pay</div>
          <div className="text-2xl font-semibold text-ink">{fmtMoney(job.workerPayCents)}</div>
        </div>
      </div>

      {/* Roof layout */}
      <WorkerRoof roof={job.roof} className="aspect-[16/9] w-full" />

      {m && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat icon={<Ruler className="h-3.5 w-3.5" />} label="Eave LF" value={`${m.eaveLF}`} />
          <Stat label="Rake LF" value={`${m.rakeLF}`} />
          <Stat label="Downspouts" value={`${m.downspoutCount}`} />
          <Stat label="Stories" value={`${m.stories}`} />
        </div>
      )}

      {/* Details */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="surface space-y-2.5 rounded-2xl border border-zinc-200 bg-white p-4">
          <h3 className="font-label text-zinc-500">Job site</h3>
          {job.clientName && <Row icon={<User className="h-4 w-4" />}>{job.clientName}</Row>}
          <Row icon={<MapPin className="h-4 w-4" />}>
            <a
              href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent-700 hover:underline"
            >
              {job.address}
            </a>
          </Row>
          {job.clientPhone && (
            <Row icon={<Phone className="h-4 w-4" />}>
              <a href={`tel:${job.clientPhone}`} className="text-accent-700 hover:underline">{job.clientPhone}</a>
            </Row>
          )}
          <Row icon={<Clock className="h-4 w-4" />}>
            {fmtWhen(job.startsAt)} – {fmtWhen(job.endsAt)}
          </Row>
        </div>

        <div className="surface rounded-2xl border border-zinc-200 bg-white p-4">
          <h3 className="font-label mb-2 text-zinc-500">What needs to be done</h3>
          {job.scope ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{job.scope}</p>
          ) : (
            <p className="text-sm text-zinc-400">No extra notes — {job.kindLabel.toLowerCase()}.</p>
          )}
        </div>
      </div>

      {job.status === "DECLINED" && job.declineReason && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">You declined: {job.declineReason}</p>
      )}

      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Actions */}
      {job.status === "OFFERED" && (
        <div className="sticky bottom-4 z-10">
          {declining ? (
            <div className="surface space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-elevated">
              <label className="block space-y-1.5">
                <span className="font-label text-zinc-500">Reason (optional)</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Booked that day, too far, etc."
                  className="input w-full resize-none"
                  autoFocus
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
                <Button variant="danger" onClick={decline} disabled={busy === "decline"}>
                  {busy === "decline" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  Decline job
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-elevated">
              <Button variant="outline" className="flex-1" onClick={() => setDeclining(true)}>
                <X className="h-4 w-4" /> Decline
              </Button>
              <Button className="flex-1" onClick={accept} disabled={busy === "accept"}>
                {busy === "accept" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Accept job
              </Button>
            </div>
          )}
        </div>
      )}

      {(job.status === "ACCEPTED" || job.status === "IN_PROGRESS") && (
        <div className="sticky bottom-4 z-10">
          <Button className="w-full" onClick={complete} disabled={busy === "complete"}>
            {busy === "complete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Mark job complete
          </Button>
        </div>
      )}

      {job.status === "COMPLETED" && (
        <div className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-50 py-3 text-sm font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> Job completed
        </div>
      )}
    </div>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-700">
      <span className="text-zinc-400">{icon}</span>
      {children}
    </div>
  );
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="surface rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        {icon} {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}
