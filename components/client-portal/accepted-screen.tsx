"use client";

import { motion } from "framer-motion";
import { CalendarClock, Check, FileText, Mail } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { formatCurrency } from "@/lib/utils";

export function AcceptedScreen({
  packageName,
  amount,
  contractor,
  signerName,
}: {
  packageName: string;
  amount: number;
  contractor: { name: string; company: string; email: string };
  signerName: string;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-30 [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_70%)]" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[400px] w-[700px] -translate-x-1/2 rounded-full bg-accent-500/10 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-4 py-16">
        <Logo />
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", damping: 14, stiffness: 220 }}
          className="mt-10 flex h-20 w-20 items-center justify-center rounded-full bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-400/40 shadow-glow"
        >
          <Check className="h-10 w-10" />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="font-display mt-6 text-balance text-center text-4xl font-semibold tracking-tight"
        >
          You're all set, <span className="text-gradient">{signerName.split(" ")[0]}</span>.
        </motion.h1>
        <p className="mt-3 max-w-md text-center text-zinc-400">
          {contractor.company} received your signed proposal and{" "}
          {formatCurrency(amount)} payment. A receipt is on its way.
        </p>

        <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile icon={Mail} title="Receipt" body="Check your inbox" />
          <Tile
            icon={CalendarClock}
            title="Scheduling"
            body={`${contractor.name} will reach out within 24 hours`}
          />
          <Tile
            icon={FileText}
            title="Documents"
            body="Signed proposal saved to your portal"
          />
        </div>

        <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-center text-sm text-zinc-400">
          Selected: <span className="font-medium text-zinc-100">{packageName}</span>{" "}
          · Paid today:{" "}
          <span className="font-medium text-zinc-100">
            {formatCurrency(amount)}
          </span>
        </div>
      </div>
    </div>
  );
}

function Tile({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <Icon className="h-5 w-5 text-accent-300" />
      <div className="mt-2 font-medium text-zinc-100">{title}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{body}</div>
    </div>
  );
}
