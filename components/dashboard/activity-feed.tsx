"use client";

import { motion } from "framer-motion";
import {
  Check,
  CreditCard,
  Eye,
  FileText,
  Mail,
  XCircle,
  Clock,
} from "lucide-react";
import { timeAgo, type ActivityEvent } from "@/lib/dashboard-mock";

const ICONS: Record<
  ActivityEvent["kind"],
  { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string }
> = {
  paid: { icon: CreditCard, bg: "bg-accent-50", fg: "text-accent-700" },
  accepted: { icon: Check, bg: "bg-accent-50", fg: "text-accent-700" },
  viewed: { icon: Eye, bg: "bg-violet-50", fg: "text-violet-700" },
  sent: { icon: Mail, bg: "bg-sky-50", fg: "text-sky-700" },
  drafted: { icon: FileText, bg: "bg-zinc-100", fg: "text-zinc-600" },
  declined: { icon: XCircle, bg: "bg-rose-50", fg: "text-rose-700" },
  expired: { icon: Clock, bg: "bg-amber-50", fg: "text-amber-700" },
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-semibold tracking-tight text-zinc-900">
          Activity
        </h3>
        <span className="text-xs text-zinc-500">Last 7 days</span>
      </div>
      <ul className="mt-4 space-y-1">
        {events.map((e, i) => {
          const meta = ICONS[e.kind];
          return (
            <motion.li
              key={e.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex gap-3 rounded-lg p-2 transition hover:bg-zinc-50"
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${meta.bg} ${meta.fg}`}
              >
                <meta.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-900">
                  {e.client}
                </div>
                <div className="truncate text-xs text-zinc-500">
                  {e.message}
                </div>
              </div>
              <div className="shrink-0 text-xs text-zinc-400">
                {timeAgo(e.at)}
              </div>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}
