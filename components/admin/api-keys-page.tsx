"use client";

import { useMemo, useState, useTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  Copy,
  Eye,
  Key,
  Lock,
  RefreshCw,
  ShieldOff,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { ApiKeyProvider } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createApiKey,
  revealApiKey,
  revokeApiKey,
  rotateApiKey,
  type ApiKeyAuditEntry,
  type ApiKeyRow,
} from "@/app/actions/api-keys";
import { ALL_PROVIDERS } from "@/lib/api-key-providers";

const PROVIDER_META: Record<
  ApiKeyProvider,
  { label: string; sub: string; tone: Parameters<typeof Badge>[0]["tone"] }
> = {
  GOOGLE_MAPS: {
    label: "Google Maps",
    sub: "Geocoding + Places",
    tone: "sky",
  },
  GOOGLE_SOLAR: {
    label: "Google Solar / Aerial",
    sub: "High-res aerial imagery + roof pitch",
    tone: "sky",
  },
  OPENAI: {
    label: "OpenAI",
    sub: "GPT-4o vision for roof segmentation",
    tone: "violet",
  },
  NEARMAP: {
    label: "Nearmap AI",
    sub: "Eave / rake vector lines",
    tone: "amber",
  },
  EAGLEVIEW: {
    label: "EagleView",
    sub: "Premium roof reports",
    tone: "amber",
  },
  RESEND: {
    label: "Resend",
    sub: "Transactional email (proposal delivery)",
    tone: "accent",
  },
  STRIPE_SECRET: {
    label: "Stripe (server)",
    sub: "Restricted server-side secret key",
    tone: "rose",
  },
  STRIPE_WEBHOOK: {
    label: "Stripe webhook",
    sub: "Signing secret (whsec_…) for /api/webhooks/stripe",
    tone: "rose",
  },
};

type Phase =
  | { kind: "idle" }
  | { kind: "add"; provider: ApiKeyProvider }
  | { kind: "rotate"; row: ApiKeyRow }
  | { kind: "reveal"; row: ApiKeyRow };

export function ApiKeysPage({
  rows: initial,
  audit: initialAudit,
}: {
  rows: ApiKeyRow[];
  audit: ApiKeyAuditEntry[];
}) {
  const [rows, setRows] = useState(initial);
  const [audit, setAudit] = useState(initialAudit);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const byProvider = useMemo(() => {
    const m = new Map<ApiKeyProvider, ApiKeyRow[]>();
    for (const p of ALL_PROVIDERS) m.set(p, []);
    for (const r of rows) {
      if (!m.has(r.provider)) m.set(r.provider, []);
      m.get(r.provider)!.push(r);
    }
    return m;
  }, [rows]);

  const configuredCount = ALL_PROVIDERS.filter(
    (p) => byProvider.get(p)?.some((r) => r.active),
  ).length;

  function handleSaved() {
    setPhase({ kind: "idle" });
    refetch();
  }

  async function refetch() {
    const { listApiKeys, listApiKeyAudit } = await import(
      "@/app/actions/api-keys"
    );
    const [r, a] = await Promise.all([listApiKeys(), listApiKeyAudit()]);
    setRows(r);
    setAudit(a);
  }

  return (
    <>
      <div className="mx-auto max-w-[1400px] space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl">
              API key vault
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-500">
              Encrypted-at-rest storage for the credentials that power the
              platform. Rotate without redeploying.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={configuredCount === ALL_PROVIDERS.length ? "accent" : "amber"}>
              <Lock className="h-3 w-3" />
              {configuredCount} of {ALL_PROVIDERS.length} configured
            </Badge>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ALL_PROVIDERS.map((provider) => {
            const meta = PROVIDER_META[provider];
            const list = byProvider.get(provider) ?? [];
            const active = list.find((r) => r.active);
            const inactive = list.filter((r) => !r.active);
            return (
              <ProviderCard
                key={provider}
                provider={provider}
                label={meta.label}
                sub={meta.sub}
                tone={meta.tone}
                active={active}
                inactive={inactive}
                onAdd={() => setPhase({ kind: "add", provider })}
                onRotate={(row) => setPhase({ kind: "rotate", row })}
                onReveal={(row) => setPhase({ kind: "reveal", row })}
                onRevoke={async (row) => {
                  if (
                    !window.confirm(
                      `Revoke ${meta.label} key (…${row.fingerprint.slice(-4)})? Apps using it will start failing immediately.`,
                    )
                  ) {
                    return;
                  }
                  await revokeApiKey(row.id);
                  await refetch();
                }}
              />
            );
          })}
        </div>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold tracking-tight text-zinc-900">
              Vault audit log
            </h2>
            <span className="text-xs text-zinc-500">
              Last {audit.length} events
            </span>
          </div>
          {audit.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
              No vault activity yet. Every create / reveal / rotate / revoke
              lands here with the actor and fingerprint.
            </div>
          ) : (
            <ul className="mt-4 space-y-1.5">
              {audit.map((e) => (
                <li
                  key={e.id}
                  className="rounded-lg border border-zinc-100 bg-zinc-50/40 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={e.action} />
                    <span className="text-zinc-700">
                      {String(e.payload.provider ?? "")}
                    </span>
                    <span className="text-zinc-400">·</span>
                    <span className="font-mono text-xs text-zinc-500">
                      …
                      {String(
                        e.payload.fingerprint ??
                          e.payload.newFingerprint ??
                          "",
                      ).slice(-6)}
                    </span>
                    <span className="ml-auto text-xs text-zinc-500">
                      {new Date(e.at).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    by {e.actorEmail}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <AddDialog
        open={phase.kind === "add"}
        provider={phase.kind === "add" ? phase.provider : undefined}
        onClose={() => setPhase({ kind: "idle" })}
        onSaved={handleSaved}
      />

      <RotateDialog
        open={phase.kind === "rotate"}
        row={phase.kind === "rotate" ? phase.row : undefined}
        onClose={() => setPhase({ kind: "idle" })}
        onSaved={handleSaved}
      />

      <RevealDialog
        open={phase.kind === "reveal"}
        row={phase.kind === "reveal" ? phase.row : undefined}
        onClose={() => setPhase({ kind: "idle" })}
      />
    </>
  );
}

function ProviderCard({
  provider,
  label,
  sub,
  tone,
  active,
  inactive,
  onAdd,
  onRotate,
  onReveal,
  onRevoke,
}: {
  provider: ApiKeyProvider;
  label: string;
  sub: string;
  tone: Parameters<typeof Badge>[0]["tone"];
  active: ApiKeyRow | undefined;
  inactive: ApiKeyRow[];
  onAdd: () => void;
  onRotate: (row: ApiKeyRow) => void;
  onReveal: (row: ApiKeyRow) => void;
  onRevoke: (row: ApiKeyRow) => void | Promise<void>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border bg-white p-5 shadow-card transition",
        active ? "border-zinc-200" : "border-dashed border-zinc-300",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={tone}>
              <Key className="h-3 w-3" />
              {label}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{sub}</p>
        </div>
        {active ? (
          <Badge tone="accent">
            <Check className="h-3 w-3" />
            Active
          </Badge>
        ) : (
          <Badge tone="amber">Missing</Badge>
        )}
      </div>

      <div className="mt-4 flex-1">
        {active ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3">
            <div className="text-xs uppercase tracking-wider text-zinc-500">
              Fingerprint
            </div>
            <div className="mt-0.5 font-mono text-sm text-zinc-900">
              ···{active.fingerprint.slice(-8)}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              <span>{active.label}</span>
              <span>·</span>
              <span>
                Added{" "}
                {new Date(active.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              {active.lastUsedAt && (
                <>
                  <span>·</span>
                  <span>
                    Last used{" "}
                    {new Date(active.lastUsedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-200 p-3 text-xs text-zinc-500">
            Not configured. The provider call will fail until a key is added.
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReveal(active)}
            >
              <Eye className="h-3.5 w-3.5" />
              Reveal
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onRotate(active)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Rotate
            </Button>
            <button
              onClick={() => onRevoke(active)}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-rose-700 transition hover:bg-rose-50"
            >
              <ShieldOff className="h-3 w-3" />
              Revoke
            </button>
          </>
        ) : (
          <Button size="sm" onClick={onAdd}>
            <Zap className="h-3.5 w-3.5" />
            Add key
          </Button>
        )}
      </div>

      {inactive.length > 0 && (
        <div className="mt-4 border-t border-zinc-100 pt-3">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex w-full items-center justify-between text-xs text-zinc-500 hover:text-zinc-900"
          >
            <span>{inactive.length} prior {inactive.length === 1 ? "key" : "keys"}</span>
            <span className="text-[10px] uppercase tracking-wider">
              {showHistory ? "Hide" : "Show"}
            </span>
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1">
              {inactive.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50/30 px-2 py-1.5 text-xs"
                >
                  <span className="font-mono text-zinc-500">
                    ···{r.fingerprint.slice(-8)}
                  </span>
                  <span className="text-zinc-400">
                    {r.rotatedAt
                      ? `rotated ${new Date(r.rotatedAt).toLocaleDateString()}`
                      : "inactive"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const map: Record<
    string,
    { label: string; tone: Parameters<typeof Badge>[0]["tone"] }
  > = {
    API_KEY_CREATED: { label: "Created", tone: "accent" },
    API_KEY_ROTATED: { label: "Rotated", tone: "sky" },
    API_KEY_REVOKED: { label: "Revoked", tone: "rose" },
    API_KEY_VIEWED: { label: "Viewed", tone: "violet" },
  };
  const meta = map[action] ?? { label: action, tone: "neutral" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function AddDialog({
  open,
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider?: ApiKeyProvider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!provider || !value.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        await createApiKey({
          provider,
          label: label.trim() || `${provider} key`,
          value,
        });
        setLabel("");
        setValue("");
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <Dialog
      open={open && !!provider}
      onClose={onClose}
      title={provider ? `Add ${PROVIDER_META[provider].label} key` : "Add key"}
    >
      {provider && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600">
            Encrypted with AES-256-GCM before storage. The plaintext value is
            never written to logs or git.
          </p>

          <Field
            label="Label"
            value={label}
            onChange={setLabel}
            placeholder={`${PROVIDER_META[provider].label} production`}
          />
          <Field
            label="Key value"
            value={value}
            onChange={setValue}
            placeholder="sk_live_… / pk_live_… / AIza…"
            mono
            type="password"
            autoFocus
          />

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || !value.trim()}>
              {pending ? "Encrypting…" : "Save key"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function RotateDialog({
  open,
  row,
  onClose,
  onSaved,
}: {
  open: boolean;
  row?: ApiKeyRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!row || !value.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        await rotateApiKey({ id: row.id, newValue: value });
        setValue("");
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Rotate failed");
      }
    });
  }

  return (
    <Dialog
      open={open && !!row}
      onClose={onClose}
      title={
        row ? `Rotate ${PROVIDER_META[row.provider].label} key` : "Rotate key"
      }
    >
      {row && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 text-xs text-zinc-600">
            Current: <span className="font-mono">···{row.fingerprint.slice(-8)}</span>
            <span className="ml-2 text-zinc-400">
              · added {new Date(row.createdAt).toLocaleDateString()}
            </span>
          </div>
          <p className="text-sm text-zinc-600">
            Save the new value first. The current key is marked inactive
            immediately — there's no overlap window, so do this when traffic
            allows for a brief failure window per provider.
          </p>

          <Field
            label="New key value"
            value={value}
            onChange={setValue}
            placeholder="Paste the new key"
            mono
            type="password"
            autoFocus
          />

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || !value.trim()}>
              {pending ? "Rotating…" : "Rotate now"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function RevealDialog({
  open,
  row,
  onClose,
}: {
  open: boolean;
  row?: ApiKeyRow;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  function reveal() {
    if (!row) return;
    startTransition(async () => {
      const r = await revealApiKey(row.id);
      setRevealed(r.value);
    });
  }

  function copy() {
    if (!revealed) return;
    navigator.clipboard.writeText(revealed).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function close() {
    setRevealed(null);
    setCopied(false);
    onClose();
  }

  return (
    <Dialog
      open={open && !!row}
      onClose={close}
      title={row ? `Reveal ${PROVIDER_META[row.provider].label}` : "Reveal"}
    >
      {row && (
        <div className="space-y-4">
          {!revealed ? (
            <>
              <p className="text-sm text-zinc-600">
                This will decrypt the value and log a{" "}
                <span className="font-medium">VIEWED</span> event with your
                identity, the timestamp, and the fingerprint.
              </p>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 text-xs text-zinc-600">
                Fingerprint:{" "}
                <span className="font-mono">···{row.fingerprint.slice(-8)}</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button size="sm" onClick={reveal} disabled={pending}>
                  {pending ? "Decrypting…" : "Reveal & log"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-500">
                Don't share this value. The reveal was logged at{" "}
                {new Date().toLocaleTimeString()}.
              </p>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Plaintext value
                </div>
                <pre className="mt-1 break-all font-mono text-sm text-zinc-900">
                  {revealed}
                </pre>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copy}
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </>
                  )}
                </Button>
                <Button size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  autoFocus?: boolean;
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
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={cn(
          "h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/15",
          mono && "font-mono",
        )}
      />
    </label>
  );
}

function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-zinc-900/30 backdrop-blur-sm" />
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-elevated"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <X className="h-4 w-4" />
            </button>
            <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
              {title}
            </h2>
            <div className="mt-4">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
