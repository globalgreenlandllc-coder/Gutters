"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { CalendarDays, MapPin, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fadeInUp, staggerContainer } from "@/lib/motion";
import { fmtDay, fmtTime, fmtMoney, STATUS_META } from "./format";
import type { WorkerJobDTO } from "@/lib/worker-dto";

export function WorkerSchedule({ jobs }: { jobs: WorkerJobDTO[] }) {
  const reduce = useReducedMotion();
  const scheduled = jobs
    .filter((j) => j.status === "ACCEPTED" || j.status === "IN_PROGRESS" || j.status === "OFFERED")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  // Group by calendar day.
  const byDay = new Map<string, WorkerJobDTO[]>();
  for (const j of scheduled) {
    const key = new Date(j.startsAt).toDateString();
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(j);
  }
  const days = [...byDay.entries()];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">Schedule</h1>
        <p className="mt-0.5 text-sm text-zinc-500">Your accepted and pending jobs, by day.</p>
      </div>

      {days.length === 0 ? (
        <div className="anim-enter-fade flex flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-400">
            <CalendarDays className="h-5 w-5" />
          </div>
          <p className="font-medium text-ink">Nothing scheduled</p>
          <p className="text-sm text-zinc-500">Accepted jobs show up here on their day.</p>
        </div>
      ) : (
        <motion.div
          className="space-y-6"
          initial={reduce ? false : "hidden"}
          animate="visible"
          variants={staggerContainer(0.06)}
        >
          {days.map(([day, dayJobs]) => (
            <motion.div key={day} variants={fadeInUp}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-ink">{fmtDay(dayJobs[0].startsAt)}</h2>
                <span className="text-xs text-zinc-400">{dayJobs.length} job{dayJobs.length > 1 ? "s" : ""}</span>
              </div>
              <div className="space-y-2">
                {dayJobs.map((j) => (
                  <Link
                    key={j.id}
                    href={`/worker/jobs/${j.id}`}
                    className="group surface flex items-center gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 hover-lift press-scale ring-focus"
                  >
                    <div className="w-16 shrink-0 text-sm font-medium text-ink">{fmtTime(j.startsAt)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-ink">{j.title}</span>
                        <Badge tone={STATUS_META[j.status].tone}>{STATUS_META[j.status].label}</Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                        <MapPin className="h-3 w-3" /> {j.address}
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-ink">{fmtMoney(j.workerPayCents)}</span>
                    <ChevronRight className="h-4 w-4 text-zinc-300 transition-smooth group-hover:translate-x-0.5 group-hover:text-zinc-500" />
                  </Link>
                ))}
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
