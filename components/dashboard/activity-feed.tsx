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
  paid: { icon: CreditCard, bg: "bg-emerald-50", fg: "text-emerald-600" },
  accepted: { icon: Check, bg: "bg-emerald-50", fg: "text-emerald-600" },
  viewed: { icon: Eye, bg: "bg-violet-50", fg: "text-violet-600" },
  sent: { icon: Mail, bg: "bg-sky-50", fg: "text-sky-600" },
  drafted: { icon: FileText, bg: "bg-zinc-100", fg: "text-zinc-500" },
  declined: { icon: XCircle, bg: "bg-rose-50", fg: "text-rose-600" },
  expired: { icon: Clock, bg: "bg-amber-50", fg: "text-amber-600" },
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight text-zinc-900">
          Activity
        </h3>
        <span className="text-xs text-zinc-400">Last 7 days</span>
      </div>
      {events.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
          Once a homeowner views, signs, or pays a proposal, you'll see it
          here in real time.
        </div>
      ) : null}
      <ul className="mt-2">
        {events.map((e, i) => {
          const meta = ICONS[e.kind];
          return (
            <motion.li
              key={e.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.03 }}
              className="flex gap-3 border-t border-zinc-100 py-3 first:border-t-0"
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${meta.bg} ${meta.fg}`}
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
