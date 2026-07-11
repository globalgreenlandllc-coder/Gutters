"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  HardHat,
  Mail,
  Plus,
  X,
  Check,
  Ban,
  Clock,
  MapPin,
  DollarSign,
  Send,
  Copy,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { JOB_KIND_OPTIONS } from "@/lib/worker-dto";
import type { JobKind } from "@prisma/client";
import {
  listWorkers,
  listOwnerJobs,
  listAssignableProposals,
  inviteWorker,
  setWorkerStatus,
  resendWorkerInvite,
  assignJob,
  cancelJob,
  type OwnerWorkerDTO,
  type OwnerJobDTO,
  type AssignableProposalDTO,
} from "@/app/actions/workers";

const fmtMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** datetime-local value → ISO; interprets the input as local time. */
const localToIso = (v: string) => (v ? new Date(v).toISOString() : "");
/** Default start = next hour, local, as a datetime-local string. */
function defaultSlot(): { start: string; end: string } {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
  const end = new Date(d.getTime() + 3 * 3600_000);
  return { start: fmt(d), end: fmt(end) };
}

const STATUS_TONE: Record<string, "accent" | "emerald" | "amber" | "rose" | "neutral" | "sky"> = {
  OFFERED: "amber",
  ACCEPTED: "emerald",
  IN_PROGRESS: "sky",
  COMPLETED: "neutral",
  DECLINED: "rose",
  CANCELLED: "neutral",
};

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="anim-enter-fade absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="surface anim-pop relative z-10 w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-elevated">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="transition-smooth ring-focus rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="font-label text-zinc-500">{label}</span>
    {children}
  </label>
);

// ── Invite modal ────────────────────────────────────────────────────────────

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [trade, setTrade] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ inviteUrl: string; emailSent: boolean } | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    const r = await inviteWorker({ email, name: name || undefined, trade: trade || undefined });
    setBusy(false);
    if (!r.ok) return setErr(r.reason);
    setSent({ inviteUrl: r.inviteUrl, emailSent: r.emailSent });
    onDone();
  }

  return (
    <Modal title="Invite a worker" onClose={onClose}>
      {sent ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            <Check className="h-4 w-4 shrink-0" />
            {sent.emailSent ? "Invite emailed." : "Worker added — email couldn't send, share the link below."}
          </div>
          <Field label="Invite link">
            <div className="flex gap-2">
              <input readOnly value={sent.inviteUrl} className="input flex-1 text-xs" />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(sent.inviteUrl)}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
          </Field>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Email *">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="crew@example.com"
              className="input w-full"
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan" className="input w-full" />
            </Field>
            <Field label="Trade">
              <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Gutter installer" className="input w-full" />
            </Field>
          </div>
          {err && <p className="text-sm text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !email}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send invite
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Assign-job modal ────────────────────────────────────────────────────────

function AssignModal({
  workers,
  proposals,
  onClose,
  onDone,
}: {
  workers: OwnerWorkerDTO[];
  proposals: AssignableProposalDTO[];
  onClose: () => void;
  onDone: () => void;
}) {
  const slot = useMemo(defaultSlot, []);
  const assignable = workers.filter((w) => w.status !== "DISABLED");
  const [workerId, setWorkerId] = useState(assignable[0]?.id ?? "");
  const [proposalId, setProposalId] = useState("");
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [kind, setKind] = useState<JobKind>("GUTTERS_REPLACEMENT");
  const [scope, setScope] = useState("");
  const [pay, setPay] = useState("");
  const [start, setStart] = useState(slot.start);
  const [end, setEnd] = useState(slot.end);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  // Prefill from the chosen proposal.
  function pickProposal(id: string) {
    setProposalId(id);
    const p = proposals.find((x) => x.id === id);
    if (p) {
      setAddress(p.address);
      setClientName(p.clientName);
      setTitle(`Install — ${p.clientName || p.address}`);
      if (p.jobType === "new") setKind("GUTTERS_NEW");
      else if (p.jobType === "replacement") setKind("GUTTERS_REPLACEMENT");
    }
  }

  async function submit(ignoreConflict: boolean) {
    setBusy(true);
    setErr(null);
    const payCents = Math.round(parseFloat(pay || "0") * 100);
    const r = await assignJob({
      workerId,
      proposalId: proposalId || null,
      title,
      address,
      clientName: clientName || null,
      clientPhone: clientPhone || null,
      kind,
      scope: scope || null,
      workerPayCents: payCents,
      startsAtIso: localToIso(start),
      endsAtIso: localToIso(end),
      ignoreConflict,
    });
    setBusy(false);
    if (r.ok) {
      onDone();
      onClose();
      return;
    }
    if ("conflict" in r && r.conflict) {
      setConflict(r.reason);
      return;
    }
    setErr(r.reason);
  }

  const worker = assignable.find((w) => w.id === workerId);

  return (
    <Modal title="Assign a job to a worker" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Worker *">
          <select value={workerId} onChange={(e) => setWorkerId(e.target.value)} className="input w-full">
            {assignable.length === 0 && <option value="">No workers — invite one first</option>}
            {assignable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name || w.email} {w.status === "INVITED" ? "(pending)" : ""}
              </option>
            ))}
          </select>
        </Field>

        {worker?.status === "INVITED" && (
          <p className="-mt-2 text-xs text-amber-600">
            This worker hasn't accepted their invite yet — they'll see the job when they join.
          </p>
        )}

        <Field label="From a proposal (optional — carries the roof layout)">
          <select value={proposalId} onChange={(e) => pickProposal(e.target.value)} className="input w-full">
            <option value="">— Manual job (no proposal) —</option>
            {proposals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.clientName || "—"} · {p.address}
                {p.hasRoof ? " · has roof" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Job title *">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Install seamless gutters" className="input w-full" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Job type">
            <select value={kind} onChange={(e) => setKind(e.target.value as JobKind)} className="input w-full">
              {JOB_KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Worker pay *">
            <div className="relative">
              <DollarSign className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                type="number"
                min="0"
                step="1"
                value={pay}
                onChange={(e) => setPay(e.target.value)}
                placeholder="0.00"
                className="input w-full pl-8"
              />
            </div>
          </Field>
        </div>

        <Field label="Job-site address *">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" className="input w-full" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Client name">
            <input value={clientName} onChange={(e) => setClientName(e.target.value)} className="input w-full" />
          </Field>
          <Field label="Client phone (optional)">
            <input value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} className="input w-full" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts *">
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="input w-full" />
          </Field>
          <Field label="Ends *">
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="input w-full" />
          </Field>
        </div>

        <Field label="What needs to be done">
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            rows={3}
            placeholder="Tear off old gutters, install 6&quot; K-style seamless, 3 downspouts to the back corners…"
            className="input w-full resize-none"
          />
        </Field>

        <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          The worker sees the client, address, roof layout, and <strong>their pay only</strong> — never your price.
        </p>

        {conflict ? (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
            <div className="flex items-start gap-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{conflict}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConflict(null)}>Change time</Button>
              <Button size="sm" onClick={() => submit(true)} disabled={busy}>Assign anyway</Button>
            </div>
          </div>
        ) : (
          <>
            {err && <p className="text-sm text-rose-600">{err}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => submit(false)} disabled={busy || !workerId || !title || !address}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Assign job
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

export function WorkersView() {
  const [workers, setWorkers] = useState<OwnerWorkerDTO[]>([]);
  const [jobs, setJobs] = useState<OwnerJobDTO[]>([]);
  const [proposals, setProposals] = useState<AssignableProposalDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"invite" | "assign" | null>(null);
  const [tab, setTab] = useState<"jobs" | "crew">("jobs");

  const refresh = useCallback(async () => {
    const [w, j, p] = await Promise.all([listWorkers(), listOwnerJobs(), listAssignableProposals()]);
    setWorkers(w);
    setJobs(j);
    setProposals(p);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl bg-zinc-100 p-1">
          {(["jobs", "crew"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "transition-smooth ring-focus press-scale rounded-lg px-4 py-1.5 text-sm font-medium capitalize",
                tab === t ? "bg-white text-ink shadow-sm" : "text-zinc-500 hover:text-zinc-800",
              )}
            >
              {t === "jobs" ? "Jobs" : "Crew"}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setModal("invite")}>
            <Mail className="h-4 w-4" /> Invite worker
          </Button>
          <Button onClick={() => setModal("assign")} disabled={workers.filter((w) => w.status !== "DISABLED").length === 0}>
            <Plus className="h-4 w-4" /> Assign job
          </Button>
        </div>
      </div>

      {loading ? (
        // Skeleton rows shaped like the job/crew cards they stand in for.
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="surface flex items-center gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3"
            >
              <div className="skeleton h-9 w-9" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="skeleton h-4 w-48 max-w-full" />
                <div className="skeleton h-3 w-72 max-w-full" />
              </div>
              <div className="skeleton h-4 w-16" />
            </div>
          ))}
        </div>
      ) : tab === "jobs" ? (
        <JobsList jobs={jobs} onChanged={refresh} onAssign={() => setModal("assign")} />
      ) : (
        <CrewList workers={workers} onChanged={refresh} onInvite={() => setModal("invite")} />
      )}

      {modal === "invite" && <InviteModal onClose={() => setModal(null)} onDone={refresh} />}
      {modal === "assign" && (
        <AssignModal workers={workers} proposals={proposals} onClose={() => setModal(null)} onDone={refresh} />
      )}
    </div>
  );
}

function JobsList({ jobs, onChanged, onAssign }: { jobs: OwnerJobDTO[]; onChanged: () => void; onAssign: () => void }) {
  if (jobs.length === 0)
    return (
      <EmptyState
        icon={<HardHat className="h-6 w-6" />}
        title="No jobs assigned yet"
        sub="Assign a proposal or a manual job to a worker — set their pay and schedule."
        action={<Button onClick={onAssign}><Plus className="h-4 w-4" /> Assign job</Button>}
      />
    );
  return (
    <div className="space-y-2.5">
      {jobs.map((j, i) => (
        <div
          key={j.id}
          className="surface anim-enter-fade flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3"
          style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-ink">{j.title}</span>
              <Badge tone={STATUS_TONE[j.status]}>{j.status.replace("_", " ").toLowerCase()}</Badge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
              <span className="inline-flex items-center gap-1"><HardHat className="h-3 w-3" /> {j.workerName}</span>
              <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {j.address}</span>
              <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtWhen(j.startsAt)}</span>
              <span>{j.kindLabel}</span>
            </div>
            {j.status === "DECLINED" && j.declineReason && (
              <p className="mt-1 text-xs text-rose-600">Declined: {j.declineReason}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-ink">{fmtMoney(j.workerPayCents)}</span>
            {!["COMPLETED", "CANCELLED", "DECLINED"].includes(j.status) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await cancelJob(j.id);
                  onChanged();
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CrewList({ workers, onChanged, onInvite }: { workers: OwnerWorkerDTO[]; onChanged: () => void; onInvite: () => void }) {
  if (workers.length === 0)
    return (
      <EmptyState
        icon={<HardHat className="h-6 w-6" />}
        title="No crew yet"
        sub="Invite a worker by email. They create their own account and see only the jobs you assign them."
        action={<Button onClick={onInvite}><Mail className="h-4 w-4" /> Invite worker</Button>}
      />
    );
  return (
    <div className="space-y-2.5">
      {workers.map((w, i) => (
        <div
          key={w.id}
          className="surface anim-enter-fade flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3"
          style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
        >
          <div className="grid h-9 w-9 place-items-center rounded-full bg-accent-50 text-accent-700">
            <HardHat className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-ink">{w.name || w.email}</span>
              {w.status === "ACTIVE" && <Badge tone="emerald">active</Badge>}
              {w.status === "INVITED" && <Badge tone="amber">invited</Badge>}
              {w.status === "DISABLED" && <Badge tone="neutral">disabled</Badge>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-zinc-500">
              <span>{w.email}</span>
              {w.trade && <span>· {w.trade}</span>}
              <span>· {w.stats.active} active · {w.stats.completed} done</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {w.status === "INVITED" && (
              <Button variant="ghost" size="sm" onClick={async () => { await resendWorkerInvite(w.id); }}>
                <Send className="h-3.5 w-3.5" /> Resend
              </Button>
            )}
            {w.status !== "DISABLED" ? (
              <Button variant="ghost" size="sm" onClick={async () => { await setWorkerStatus(w.id, "DISABLED"); onChanged(); }}>
                <Ban className="h-3.5 w-3.5" /> Disable
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={async () => { await setWorkerStatus(w.id, "ACTIVE"); onChanged(); }}>
                <Check className="h-3.5 w-3.5" /> Enable
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, sub, action }: { icon: React.ReactNode; title: string; sub: string; action: React.ReactNode }) {
  return (
    <div className="surface anim-enter flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-400">{icon}</div>
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">{sub}</p>
      </div>
      {action}
    </div>
  );
}
