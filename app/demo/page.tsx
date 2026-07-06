import Link from "next/link";
import { ArrowLeft, ArrowRight, Map, FileText } from "lucide-react";

export const metadata = {
  title: "Takeoff Demos — Gutters",
  description:
    "Two interactive ways to measure gutter linear footage: from satellite imagery or from an uploaded blueprint.",
};

const METHODS = [
  {
    href: "/demo/satellite",
    tag: "Method A",
    icon: Map,
    title: "Satellite Map Takeoff",
    blurb:
      "Type an address, pull high-resolution aerial imagery, and get an auto-traced roof outline. Drag eaves to fine-tune, drop downspouts, and read live linear-footage and cost.",
    points: ["Address → aerial in one step", "Auto-traced eaves & rakes", "Ground-sample scale (no calibration)"],
  },
  {
    href: "/demo/blueprint",
    tag: "Method B",
    icon: FileText,
    title: "Blueprint Upload Takeoff",
    blurb:
      "Drop an architectural plan, calibrate the scale with a two-point measurement against a known dimension, then trace the roof edges for exact, plan-accurate footage.",
    points: ["Upload a plan sheet", "2-point scale calibration", "Trace & measure to the inch"],
  },
];

export default function DemoIndexPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" /> Back home
        </Link>

        <header className="mt-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
            Interactive Takeoff
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            Two ways to measure a roof.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-400">
            Both flows render the same blueprint-style canvas — glowing cyan
            eaves, draggable vertices, live linear footage — over two different
            data sources. Pick one to try.
          </p>
        </header>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {METHODS.map((m) => {
            const Icon = m.icon;
            return (
              <Link
                key={m.href}
                href={m.href}
                className="group relative flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-7 transition hover:border-cyan-500/50 hover:bg-slate-900"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/20">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                    {m.tag}
                  </span>
                </div>
                <h2 className="mt-5 text-xl font-semibold text-slate-50">
                  {m.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {m.blurb}
                </p>
                <ul className="mt-5 space-y-2 text-sm text-slate-300">
                  {m.points.map((p) => (
                    <li key={p} className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      {p}
                    </li>
                  ))}
                </ul>
                <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-cyan-400">
                  Open demo
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
}
