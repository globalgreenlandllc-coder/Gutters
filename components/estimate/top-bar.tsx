"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Save,
  Send,
} from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  writeEstimateHandoff,
  type EstimateHandoff,
} from "@/lib/estimate-handoff";
import { saveDraftFromEstimate } from "@/app/actions/proposals";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; draftId: string; at: number }
  | { kind: "error"; message: string };

export function TopBar({
  address,
  handoff,
}: {
  address: string;
  /** Full takeoff snapshot. Optional because some call sites don't have
   *  it (the proposal page just gets the address) — when absent the
   *  navigation still works, the proposal flow falls back to its blank
   *  template. */
  handoff?: Omit<EstimateHandoff, "capturedAt">;
}) {
  const router = useRouter();
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [, startTransition] = useTransition();

  const handoffAndGo = () => {
    if (handoff) writeEstimateHandoff(handoff);
    router.push("/proposal");
  };

  const onSaveDraft = () => {
    if (!handoff || save.kind === "saving") return;
    setSave({ kind: "saving" });
    startTransition(async () => {
      const existingId =
        save.kind === "saved" ? save.draftId : undefined;
      const result = await saveDraftFromEstimate({
        address: handoff.address,
        measurements: handoff.measurements,
        eaves: handoff.eaves,
        rakes: handoff.rakes,
        downspouts: handoff.downspouts,
        aerial: handoff.aerial,
        // Total isn't committed at the estimate stage — leave at 0; the
        // proposal list renders "Pending" for zero-totalled drafts. The
        // contractor finalizes pricing in /proposal before sending.
        totalCents: 0,
        existingId,
      });
      if (result.ok) {
        setSave({ kind: "saved", draftId: result.id, at: Date.now() });
      } else {
        setSave({ kind: "error", message: result.reason });
      }
    });
  };

  // Status badge on the address line. Reflects what the contractor sees
  // when they navigate to /dashboard/proposals: nothing → Draft → Saved.
  const statusBadge =
    save.kind === "saved" ? (
      <Badge tone="accent" className="hidden sm:inline-flex">
        <Check className="h-3 w-3" />
        Saved · Draft
      </Badge>
    ) : save.kind === "saving" ? (
      <Badge tone="neutral" className="hidden sm:inline-flex">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </Badge>
    ) : (
      <Badge tone="neutral" className="hidden sm:inline-flex">
        Draft
      </Badge>
    );

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-sm text-zinc-500 transition hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Dashboard</span>
        </Link>
        <div className="hidden h-6 w-px bg-zinc-200 md:block" />
        <div className="hidden md:block">
          <Logo showSubtitle={false} />
        </div>
        <div className="hidden h-6 w-px bg-zinc-200 md:block" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-900">
              {address}
            </span>
            {statusBadge}
          </div>
          <div className="text-xs text-zinc-500">
            {save.kind === "saved" ? (
              <>
                Saved to{" "}
                <Link
                  href="/dashboard/proposals"
                  className="text-accent-700 underline-offset-2 hover:underline"
                >
                  Proposals
                </Link>
                {" · "}
                {timeAgo(save.at)} · AI confidence 96%
              </>
            ) : save.kind === "error" ? (
              <span className="text-rose-600">{save.message}</span>
            ) : (
              "AI confidence 96% · 2 corrections suggested"
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={handoffAndGo}
          >
            <Download className="h-4 w-4" />
            PDF
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSaveDraft}
            disabled={!handoff || save.kind === "saving"}
            title={
              save.kind === "saved"
                ? "Update the saved draft"
                : "Save a draft to your Proposals list"
            }
          >
            {save.kind === "saving" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : save.kind === "saved" ? (
              <Check className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {save.kind === "saving"
              ? "Saving…"
              : save.kind === "saved"
                ? "Saved"
                : "Save proposal"}
          </Button>
          <Button size="sm" onClick={handoffAndGo}>
            <Send className="h-4 w-4" />
            Send proposal
          </Button>
        </div>
      </div>
    </header>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
