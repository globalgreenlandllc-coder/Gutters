"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Proposal } from "@/lib/proposal-mock";
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
    setPhase("sent");
  }

  function handleClose() {
    setPhase("compose");
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
          <div className="absolute inset-0 bg-black/70 backdrop-blur" />
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-ink-900 shadow-glow-lg"
          >
            <button
              onClick={handleClose}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>

            {phase === "compose" ? (
              <div className="p-6">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-400/30">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="font-display text-lg font-semibold tracking-tight">
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
                      className="w-full bg-transparent text-sm text-zinc-100 outline-none"
                    />
                  </Row>
                  <Row label="Subject">
                    <input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      className="w-full bg-transparent text-sm text-zinc-100 outline-none"
                    />
                  </Row>
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={6}
                      className="w-full resize-none bg-transparent text-sm leading-relaxed text-zinc-200 outline-none"
                    />
                  </div>
                  <Row label="Portal link">
                    <div className="flex w-full items-center gap-2">
                      <span className="truncate text-xs text-zinc-400">
                        {portalUrl}
                      </span>
                      <button
                        type="button"
                        onClick={copy}
                        className={cn(
                          "ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition",
                          copied
                            ? "border-accent-400/40 bg-accent-500/10 text-accent-300"
                            : "border-white/10 text-zinc-300 hover:border-accent-400/40 hover:text-accent-300",
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

                <div className="mt-6 flex items-center justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={send}>
                    <Mail className="h-4 w-4" />
                    Send to {proposal.client.name.split(" ")[0]}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center">
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", damping: 14, stiffness: 220 }}
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-400/40"
                >
                  <Check className="h-6 w-6" />
                </motion.div>
                <h2 className="font-display mt-4 text-xl font-semibold tracking-tight">
                  Proposal sent
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  {proposal.client.name} will receive an email and can review,
                  sign, and pay from the portal.
                </p>
                <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <Button
                    size="sm"
                    onClick={() => window.open(`/p/${proposal.token}`, "_blank")}
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
    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <span className="w-20 shrink-0 text-xs uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
