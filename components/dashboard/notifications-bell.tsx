"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  X,
  CheckCircle2,
  HardHat,
  LifeBuoy,
  Megaphone,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { listWorkerActivity, type WorkerActivityDTO } from "@/app/actions/workers";
import { getBellCounts, type BellCounts } from "@/app/actions/notifications";

const SEEN_KEY = "gutters:worker-activity-seen";

/** Notifications bell: recent worker job responses (accepted / declined /
 *  completed) PLUS support replies and new announcements. The worker dot uses
 *  a localStorage watermark; support/announcement counts are derived
 *  (PENDING tickets / undismissed announcements) so they clear on action. */
export function NotificationsBell() {
  const [items, setItems] = useState<WorkerActivityDTO[]>([]);
  const [counts, setCounts] = useState<BellCounts>({
    support: 0,
    announcements: 0,
    adminTickets: 0,
  });
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState<string>(() => {
    if (typeof window === "undefined") return new Date(0).toISOString();
    return localStorage.getItem(SEEN_KEY) ?? new Date(0).toISOString();
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      listWorkerActivity().then((a) => alive && setItems(a));
      getBellCounts().then((c) => alive && setCounts(c));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const unseen =
    items.filter((i) => i.at > seenAt).length +
    counts.support +
    counts.announcements;
  const hasComms = counts.support > 0 || counts.announcements > 0;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      const now = new Date().toISOString();
      localStorage.setItem(SEEN_KEY, now);
      setSeenAt(now);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        className="transition-smooth ring-focus relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unseen > 0 && (
          <span className="anim-pop absolute right-1.5 top-1.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent-600 px-0.5 text-[9px] font-bold leading-none text-white">
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <div className="anim-pop origin-top-right absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-2xl border border-zinc-200/70 bg-white shadow-elevated">
          {hasComms && (
            <div className="border-b border-zinc-100 py-1">
              {counts.support > 0 && (
                <Link
                  href="/dashboard/support"
                  onClick={() => setOpen(false)}
                  className="transition-smooth ring-focus flex items-center gap-2.5 px-4 py-2.5 hover:bg-zinc-50"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-50 text-accent-700">
                    <LifeBuoy className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-zinc-700">
                    {counts.support === 1
                      ? "A support reply is waiting"
                      : `${counts.support} support replies waiting`}
                  </span>
                  <span className="grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                    {counts.support}
                  </span>
                </Link>
              )}
              {counts.announcements > 0 && (
                <Link
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                  className="transition-smooth ring-focus flex items-center gap-2.5 px-4 py-2.5 hover:bg-zinc-50"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-50 text-accent-700">
                    <Megaphone className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-zinc-700">
                    {counts.announcements === 1
                      ? "New announcement"
                      : `${counts.announcements} new announcements`}
                  </span>
                  <span className="grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                    {counts.announcements}
                  </span>
                </Link>
              )}
            </div>
          )}
          <div className="border-b border-zinc-100 px-4 py-2.5 text-sm font-semibold tracking-tight text-zinc-900">
            Worker activity
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-400">
              No recent responses from your crew.
            </div>
          ) : (
            <ul className="max-h-96 divide-y divide-zinc-50 overflow-y-auto">
              {items.map((i) => (
                <li key={i.id}>
                  <Link
                    href="/dashboard/workers"
                    onClick={() => setOpen(false)}
                    className="transition-smooth ring-focus flex items-start gap-2.5 px-4 py-2.5 hover:bg-zinc-50"
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full",
                        i.event === "ACCEPTED" && "bg-emerald-50 text-emerald-600",
                        i.event === "DECLINED" && "bg-rose-50 text-rose-600",
                        i.event === "STARTED" && "bg-sky-50 text-sky-600",
                        i.event === "COMPLETED" && "bg-accent-50 text-accent-700",
                      )}
                    >
                      {i.event === "ACCEPTED" && <Check className="h-3.5 w-3.5" />}
                      {i.event === "DECLINED" && <X className="h-3.5 w-3.5" />}
                      {i.event === "STARTED" && <Play className="h-3.5 w-3.5" />}
                      {i.event === "COMPLETED" && <CheckCircle2 className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 text-sm text-zinc-700">
                      <strong className="font-medium text-ink">{i.workerName}</strong>{" "}
                      {i.event === "ACCEPTED"
                        ? "accepted"
                        : i.event === "DECLINED"
                          ? "declined"
                          : i.event === "STARTED"
                            ? "started"
                            : "completed"}{" "}
                      <span className="text-zinc-500">“{i.jobTitle}”</span>
                      {i.declineReason && (
                        <span className="mt-0.5 block truncate text-xs text-rose-600">
                          {i.declineReason}
                        </span>
                      )}
                      <span className="mt-0.5 block text-[11px] text-zinc-400">
                        {new Date(i.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/dashboard/workers"
            onClick={() => setOpen(false)}
            className="transition-smooth ring-focus flex items-center justify-center gap-1.5 border-t border-zinc-100 px-4 py-2 text-xs font-medium text-accent-700 hover:bg-zinc-50"
          >
            <HardHat className="h-3.5 w-3.5" /> Manage workers
          </Link>
        </div>
      )}
    </div>
  );
}
