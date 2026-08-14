"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { MapPin, Clock, User, ChevronRight, Briefcase } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fadeInUp, staggerContainer } from "@/lib/motion";
import { fmtMoney, fmtWhen, STATUS_META } from "./format";
import type { WorkerJobDTO } from "@/lib/worker-dto";

type Filter = "offers" | "upcoming" | "done";

export function WorkerJobsClient({ initialJobs }: { initialJobs: WorkerJobDTO[] }) {
  const [filter, setFilter] = useState<Filter>(initialJobs.some((j) => j.status === "OFFERED") ? "offers" : "upcoming");
  const reduce = useReducedMotion();

  const groups = useMemo(() => {
    return {
      offers: initialJobs.filter((j) => j.status === "OFFERED"),
      upcoming: initialJobs.filter((j) => j.status === "ACCEPTED" || j.status === "IN_PROGRESS"),
      done: initialJobs.filter((j) => ["COMPLETED", "DECLINED", "CANCELLED"].includes(j.status)),
    };
  }, [initialJobs]);

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "offers", label: "New offers", count: groups.offers.length },
    { key: "upcoming", label: "Upcoming", count: groups.upcoming.length },
    { key: "done", label: "History", count: groups.done.length },
  ];

  const jobs = groups[filter];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">My jobs</h1>
        <p className="mt-0.5 text-sm text-zinc-500">Jobs your contractor assigned you. Tap a job to see the roof and respond.</p>
      </div>

      <div className="inline-flex rounded-xl bg-zinc-100 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={cn(
              "rounded-lg px-3.5 py-1.5 text-sm font-medium transition-smooth ring-focus press-scale",
              filter === t.key ? "bg-white text-ink shadow-sm" : "text-zinc-500 hover:text-zinc-800",
            )}
          >
            {t.label}
            {t.count > 0 && (
              <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] transition-smooth", filter === t.key ? "bg-accent-50 text-accent-700" : "bg-zinc-200 text-zinc-500")}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {jobs.length === 0 ? (
        <div key={filter} className="anim-enter-fade flex flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-400">
            <Briefcase className="h-5 w-5" />
          </div>
          <p className="font-medium text-ink">Nothing here yet</p>
          <p className="text-sm text-zinc-500">
            {filter === "offers" ? "No new job offers right now." : filter === "upcoming" ? "No upcoming jobs." : "No past jobs."}
          </p>
        </div>
      ) : (
        <motion.div
          key={filter}
          className="grid gap-3 sm:grid-cols-2"
          initial={reduce ? false : "hidden"}
          animate="visible"
          variants={staggerContainer(0.05)}
        >
          {jobs.map((j) => (
            <motion.div key={j.id} variants={fadeInUp}>
              <Link
                href={`/worker/jobs/${j.id}`}
                className="group surface flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white hover-lift press-scale ring-focus"
              >
                <div className="flex items-start justify-between gap-2 px-4 pt-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={STATUS_META[j.status].tone}>{STATUS_META[j.status].label}</Badge>
                      <span className="text-xs text-zinc-400">{j.kindLabel}</span>
                    </div>
                    <h3 className="mt-1.5 truncate font-semibold text-ink">{j.title}</h3>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-smooth group-hover:translate-x-0.5 group-hover:text-zinc-500" />
                </div>
                <div className="space-y-1 px-4 py-3 text-xs text-zinc-500">
                  {j.clientName && (
                    <div className="flex items-center gap-1.5"><User className="h-3.5 w-3.5" /> {j.clientName}</div>
                  )}
                  <div className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {j.address}</div>
                  <div className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> {fmtWhen(j.startsAt)}</div>
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-zinc-100 bg-zinc-50/60 px-4 py-2.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Your pay</span>
                  <span className="text-base font-semibold text-ink">{fmtMoney(j.workerPayCents)}</span>
                </div>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
