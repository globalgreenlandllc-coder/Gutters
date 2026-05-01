"use client";

import Link from "next/link";
import { ArrowLeft, Download, Eye, Pencil, Send } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function ProposalTopBar({
  address,
  preview,
  onTogglePreview,
  onSend,
  onDownload,
}: {
  address: string;
  preview: boolean;
  onTogglePreview: () => void;
  onSend: () => void;
  onDownload: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/80 backdrop-blur-xl print:hidden">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4">
        <Link
          href="/estimate"
          className="flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Estimate</span>
        </Link>
        <div className="hidden h-6 w-px bg-white/10 md:block" />
        <div className="hidden md:block">
          <Logo />
        </div>
        <div className="hidden h-6 w-px bg-white/10 md:block" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">
              Proposal · {address}
            </span>
            <Badge tone={preview ? "accent" : "neutral"}>
              {preview ? "Client preview" : "Draft"}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          <button
            onClick={() => preview && onTogglePreview()}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition",
              !preview
                ? "bg-white/[0.06] text-zinc-100"
                : "text-zinc-400 hover:text-white",
            )}
          >
            <Pencil className="h-3.5 w-3.5" />
            Builder
          </button>
          <button
            onClick={() => !preview && onTogglePreview()}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition",
              preview
                ? "bg-accent-500/20 text-accent-300 ring-1 ring-inset ring-accent-400/30"
                : "text-zinc-400 hover:text-white",
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview
          </button>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={onDownload}
          className="hidden sm:inline-flex"
        >
          <Download className="h-4 w-4" />
          PDF
        </Button>
        <Button size="sm" onClick={onSend}>
          <Send className="h-4 w-4" />
          Send
        </Button>
      </div>
    </header>
  );
}
