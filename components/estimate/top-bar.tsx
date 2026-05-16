"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Send } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { writeEstimateHandoff } from "@/lib/estimate-handoff";
import type { Measurements } from "@/lib/types";

export function TopBar({
  address,
  measurements,
}: {
  address: string;
  /** Live measurements snapshot. Optional because some call sites (e.g.
   *  a future read-only embed) don't have it — when absent, the proposal
   *  flow falls back to its blank template, same as before this prop
   *  existed. */
  measurements?: Measurements;
}) {
  const router = useRouter();
  const handoffAndGo = () => {
    if (measurements) {
      writeEstimateHandoff({ address, measurements });
    }
    router.push("/proposal");
  };
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
            <Badge tone="neutral" className="hidden sm:inline-flex">
              Draft
            </Badge>
          </div>
          <div className="text-xs text-zinc-500">
            AI confidence 96% · 2 corrections suggested
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
          <Button size="sm" onClick={handoffAndGo}>
            <Send className="h-4 w-4" />
            Send proposal
          </Button>
        </div>
      </div>
    </header>
  );
}
