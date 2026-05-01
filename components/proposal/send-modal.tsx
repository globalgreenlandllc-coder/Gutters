"use client";

import { useState, useTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Check, Copy, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Proposal } from "@/lib/proposal-mock";
import { sendProposal } from "@/app/actions/proposals";
import { cn } from "@/lib/utils";

export function SendModal({
  open,
  onClose,
  proposal,
}: {
  open: boolean;
  onClose: () => void;
  proposal: Proposal;
}) {
  const [phase, setPhase] = useState<"compose" | "sent">("compose");
  const [subject, setSubject] = useState(
    `Your gutter proposal — ${proposal.address}`,
  );
  const [message, setMessage] = useState(
    `Hi ${proposal.client.name.split(" ")[0]},\n\nAttached is your gutter replacement proposal. Tap below to review the three options, sign, and pay your deposit. Pricing locked for ${proposal.validDays} days.\n\n— ${proposal.contractor.name}`,
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [sentPortalUrl, setSentPortalUrl] = useState<string | null>(null);
  const portalUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/p/${proposal.token}`
      : `/p/${proposal.token}`;

  function copy() {
    navigator.clipboard?.writeText(portalUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const res = await sendProposal({ proposal, subject, message });
      if (res.ok) {
        setSentPortalUrl(res.portalUrl);
        setPhase("sent");
      } else {
        setError(res.reason);
      }
    });
  }

  function handleClose() {
    setPhase("compose");
    setError(null);
    setSentPortalUrl(null);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={handleClose}
        >
          <div className="absolute inset-0 bg-zinc-900/40 backdrop-blur-sm" />
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-elevated"
          >
            <button
              onClick={handleClose}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <X className="h-4 w-4" />
            </button>

            {phase === "compose" ? (
              <div className="p-6">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="font-display text-lg font-semibold tracking-tight text-zinc-900">
                      Send proposal
                    </h2>
                    <p className="text-xs text-zinc-500">
                      Delivered via Resend with a secure portal link.
                    </p>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  <Row label="To">
                    <input
                      readOnly
                      value={`${proposal.client.name} <${proposal.client.email}>`}
                      className="w-full bg-transparent text-sm text-zinc-900 outline-none"
                    />
                  </Row>
                  <Row label="Subject">
                    <input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      className="w-full bg-transparent text-sm text-zinc-900 outline-none"
                    />
                  </Row>
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-3">
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={6}
                      className="w-full resize-none bg-transparent text-sm leading-relaxed text-zinc-700 outline-none"
                    />
                  </div>
                  <Row label="Portal link">
                    <div className="flex w-full items-center gap-2">
                      <span className="truncate text-xs text-zinc-600">
                        {portalUrl}
                      </span>
                      <button
                        type="button"
                        onClick={copy}
                        className={cn(
                          "ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition",
                          copied
                            ? "border-accent-200 bg-accent-50 text-accent-700"
                            : "border-zinc-200 text-zinc-700 hover:border-accent-400 hover:text-accent-700",
                        )}
                      >
                        {copied ? (
                          <>
                            <Check className="h-3 w-3" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                  </Row>
                </div>

                {error && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div>
                      <div className="font-medium">Couldn't send</div>
                      <div className="mt-0.5 text-rose-700/90">{error}</div>
                    </div>
                  </div>
                )}

                <div className="mt-6 flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleClose}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={send} disabled={pending}>
                    <Mail className="h-4 w-4" />
                    {pending
                      ? "Sending…"
                      : `Send to ${proposal.client.name.split(" ")[0] || "client"}`}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center">
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", damping: 14, stiffness: 220 }}
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-50 text-accent-700 ring-1 ring-inset ring-accent-200"
                >
                  <Check className="h-6 w-6" />
                </motion.div>
                <h2 className="font-display mt-4 text-xl font-semibold tracking-tight text-zinc-900">
                  Proposal sent
                </h2>
                <p className="mt-1 text-sm text-zinc-600">
                  {proposal.client.name} will receive an email and can review,
                  sign, and pay from the portal.
                </p>
                <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <Button
                    size="sm"
                    onClick={() =>
                      window.open(
                        sentPortalUrl ?? `/p/${proposal.token}`,
                        "_blank",
                      )
                    }
                  >
                    Open client portal
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleClose}>
                    Back to builder
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <span className="w-20 shrink-0 text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
