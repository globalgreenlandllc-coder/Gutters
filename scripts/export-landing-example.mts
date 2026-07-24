/**
 * Bake a real, contractor-corrected takeoff into the landing-page example
 * (components/landing2/example-scan-data.ts + public/landing/example-aerial.*).
 *
 * The landing "see a finished example" panel renders this snapshot statically —
 * no API spend, instant, and it shows contractor-verified gutters instead of a
 * cold scan. Sources, in order:
 *   1. a saved Proposal whose data.takeoff matches the address pattern;
 *   2. an admin accuracy-lab run (test_lab_runs) — correctedJson is the
 *      ground truth the admin drew, aerialData the orthophoto it sits on.
 *
 * Run against the DB that holds the corrected data:
 *
 *   DATABASE_URL=<url> npx tsx scripts/export-landing-example.mts "97th"
 *
 * The argument is an address substring; the newest match with geometry wins.
 * Coordinates are rounded to 0.1 canvas px to keep the generated module small.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  blankProposal,
  deriveTotalCentsFromData,
  packageTotal,
  type Package,
} from "../lib/proposal-mock";
import { polylineLengthFt } from "../lib/diagram-geom";
import type { Measurements } from "../lib/types";

const pattern = process.argv[2];
/** Optional source override: "lab" | "proposal" (default: proposal, then lab). */
const sourcePref = process.argv[3] ?? "";
if (!pattern) {
  console.error('Usage: DATABASE_URL=<url> npx tsx scripts/export-landing-example.mts "<address substring>" [lab|proposal]');
  process.exit(1);
}

const db = new PrismaClient();

type Pt = { x: number; y: number };
const r1 = (n: number) => Math.round(n * 10) / 10;
const roundPts = (pts: Pt[]) => pts.map((p) => ({ x: r1(p.x), y: r1(p.y) }));

const slimLines = (lines: any[]): any[] =>
  (lines ?? []).map((l) => ({
    id: l.id,
    kind: l.kind,
    points: roundPts(l.points ?? []),
  }));

const slimRoof = (roof: any) =>
  roof
    ? {
        perimeter: roundPts(roof.perimeter ?? []),
        ridges: (roof.ridges ?? []).map((s: any) => ({ ...s, points: roundPts(s.points ?? []) })),
        valleys: (roof.valleys ?? []).map((s: any) => ({ ...s, points: roundPts(s.points ?? []) })),
        confidence: roof.confidence ?? 1,
      }
    : undefined;

/** Decode a data-URL image into public/landing/ (re-encoded as a quality-80
 *  JPEG via sharp — orthophoto PNGs are ~4× heavier for no visible gain on a
 *  marketing page), return its public path. */
async function bakeAerial(dataUrl: string | null | undefined): Promise<string | null> {
  if (!dataUrl?.startsWith("data:")) return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/s);
  if (!m) return null;
  const raw = Buffer.from(m[2], "base64");
  const { default: sharp } = await import("sharp");
  const jpg = await sharp(raw).jpeg({ quality: 80 }).toBuffer();
  const file = "example-aerial.jpg";
  mkdirSync(join(process.cwd(), "public/landing"), { recursive: true });
  writeFileSync(join(process.cwd(), "public/landing", file), jpg);
  console.log(
    `wrote public/landing/${file} (${Math.round(jpg.length / 1024)} KB, from ${Math.round(raw.length / 1024)} KB ${m[1]})`,
  );
  return `/landing/${file}`;
}

/** Price like the estimate→draft flow: blank template, middle tier. */
function defaultEstimateCents(measurements: Measurements): number {
  const blank = blankProposal();
  const pick = blank.packages[1] ?? blank.packages[0];
  if (!pick) return 0;
  try {
    const { total } = packageTotal(pick, measurements);
    return Math.max(0, Math.round(total * 100));
  } catch {
    return 0;
  }
}

type Snapshot = {
  address: string;
  eaves: any[];
  rakes: any[];
  downspouts: any[];
  roofStructure?: any;
  canvasPxPerFt?: number;
  aerialUrl: string | null;
  stats: { eaveLF: number; downspoutCount: number; corners: number; stories: number };
  estimateTotalCents: number;
  sourceNote: string;
};

async function fromProposal(): Promise<Snapshot | null> {
  const rows = await db.proposal.findMany({
    where: { address: { contains: pattern, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      address: true,
      totalCents: true,
      selectedPackageId: true,
      updatedAt: true,
      data: true,
    },
  });
  const row = rows.find((r) => {
    const takeoff = (r.data as Record<string, unknown> | null)?.takeoff as
      | Record<string, unknown>
      | undefined;
    return Array.isArray(takeoff?.eaves) && (takeoff!.eaves as unknown[]).length > 0;
  });
  if (!row) return null;
  const data = row.data as Record<string, any>;
  const takeoff = data.takeoff as Record<string, any>;
  const m = (data.measurements ?? {}) as Record<string, any>;
  return {
    address: row.address.replace(/,?\s*USA$/i, ""),
    eaves: slimLines(takeoff.eaves),
    rakes: slimLines(takeoff.rakes),
    downspouts: (takeoff.downspouts ?? []).map((d: any) => ({
      id: d.id,
      x: r1(d.x),
      y: r1(d.y),
      heightFt: d.heightFt ?? 10,
    })),
    roofStructure: slimRoof(takeoff.roofStructure),
    canvasPxPerFt: takeoff.canvasPxPerFt ?? undefined,
    aerialUrl: await bakeAerial(takeoff.aerial?.imageDataUrl),
    stats: {
      eaveLF: Math.round(m.eaveLF ?? 0),
      downspoutCount: m.downspoutCount ?? takeoff.downspouts?.length ?? 0,
      corners: (m.outsideCorners ?? 0) + (m.insideCorners ?? 0),
      stories: m.stories ?? 1,
    },
    estimateTotalCents: deriveTotalCentsFromData(row.data, row.totalCents, row.selectedPackageId),
    sourceNote: `proposal ${row.id} (updated ${row.updatedAt.toISOString()})`,
  };
}

async function fromAccuracyLab(): Promise<Snapshot | null> {
  const rows = await db.testLabRun.findMany({
    where: { address: { contains: pattern, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      address: true,
      status: true,
      updatedAt: true,
      correctedJson: true,
      engineJson: true,
      aerialData: true,
      canvasPxPerFt: true,
    },
  });
  // Prefer the newest CORRECTED run (admin-drawn ground truth); fall back to
  // the newest run that has any usable geometry.
  const usable = rows.filter((r) => {
    const g = (r.correctedJson ?? r.engineJson) as Record<string, any> | null;
    return Array.isArray(g?.eaves) && g!.eaves.length > 0;
  });
  const row = usable.find((r) => r.status === "CORRECTED" && r.correctedJson) ?? usable[0];
  if (!row) return null;

  const engine = (row.engineJson ?? {}) as Record<string, any>;
  const truth = (row.correctedJson ?? engine) as Record<string, any>;
  const pxPerFt: number | undefined = row.canvasPxPerFt ?? engine.canvasPxPerFt ?? undefined;
  const eaves = slimLines(truth.eaves);
  const downspouts = (truth.downspouts ?? []).map((d: any) => ({
    id: d.id,
    x: r1(d.x),
    y: r1(d.y),
    heightFt: d.heightFt ?? 10,
  }));

  // The lab stores the corrected TRACE, not recomputed totals — footage is
  // derived from the drawn lines exactly like the estimate canvas does
  // (Σ polyline length ÷ px-per-ft). Corner/story counts stay from the
  // engine measurements, same as the app's live recompute.
  const engineM = (engine.measurements ?? {}) as Record<string, any>;
  const eaveLF = Math.round(
    eaves.reduce((acc: number, l: any) => {
      const v = polylineLengthFt(l.points, pxPerFt ?? 1);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );
  const measurements = {
    ...engineM,
    eaveLF,
    downspoutCount: downspouts.length,
  } as Measurements;

  // Price + display address through the owner's real proposal for the same
  // address when one exists — its packages carry their actual material
  // config/markup, unlike the blank template's defaults.
  let estimateTotalCents = defaultEstimateCents(measurements);
  let displayAddress = row.address;
  let priceNote = "blank-template pricing";
  const proposal = await db.proposal.findFirst({
    where: { address: { contains: pattern, mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, address: true, data: true },
  });
  if (proposal) {
    displayAddress = proposal.address;
    const packages = ((proposal.data as Record<string, any>)?.packages ?? []) as Package[];
    const pick = packages.find((p) => p.recommended) ?? packages[1] ?? packages[0];
    if (pick) {
      try {
        const { total } = packageTotal(pick, measurements);
        if (total > 0) {
          estimateTotalCents = Math.round(total * 100);
          priceNote = `priced via proposal ${proposal.id} package "${pick.name ?? pick.id}"`;
        }
      } catch {
        // malformed packages — keep the template fallback
      }
    }
  }

  return {
    address: displayAddress.replace(/,?\s*USA$/i, ""),
    eaves,
    rakes: slimLines(truth.rakes),
    downspouts,
    roofStructure: slimRoof(engine.roofStructure),
    canvasPxPerFt: pxPerFt,
    aerialUrl: await bakeAerial(row.aerialData),
    stats: {
      eaveLF,
      downspoutCount: downspouts.length,
      corners: (engineM.outsideCorners ?? 0) + (engineM.insideCorners ?? 0),
      stories: engineM.stories ?? 1,
    },
    estimateTotalCents,
    sourceNote: `accuracy-lab run ${row.id} [${row.status}] (updated ${row.updatedAt.toISOString()}), ${priceNote}`,
  };
}

async function main() {
  const snap =
    sourcePref === "lab"
      ? await fromAccuracyLab()
      : sourcePref === "proposal"
        ? await fromProposal()
        : ((await fromProposal()) ?? (await fromAccuracyLab()));
  if (!snap) {
    console.error(`No proposal or accuracy-lab run matching "${pattern}" with geometry found.`);
    process.exit(2);
  }
  const { sourceNote, ...snapshot } = snap;

  const module_ = `// AUTO-GENERATED by scripts/export-landing-example.mts — do not hand-edit the
// EXAMPLE_SCAN value. Re-run the script to refresh it from a saved proposal
// or accuracy-lab run:
//
//   DATABASE_URL=<url> npx tsx scripts/export-landing-example.mts "97th"
//
// Source: ${sourceNote}

import type { Downspout, EditableLine, RoofStructure } from "@/lib/types";

export type ExampleScan = {
  /** Display label, e.g. "6232 97th Dr NE, Lake Stevens, WA". */
  address: string;
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
  roofStructure?: RoofStructure;
  canvasPxPerFt?: number;
  /** Public asset path of the baked aerial photo (null = diagram only). */
  aerialUrl: string | null;
  stats: {
    eaveLF: number;
    downspoutCount: number;
    corners: number;
    stories: number;
  };
  /** Derived contract total of the source proposal, in cents. */
  estimateTotalCents: number;
};

export const EXAMPLE_SCAN: ExampleScan | null = ${JSON.stringify(snapshot, null, 2)};
`;
  writeFileSync(join(process.cwd(), "components/landing2/example-scan-data.ts"), module_);
  console.log(
    `wrote components/landing2/example-scan-data.ts — ${snapshot.eaves.length} eaves, ` +
      `${snapshot.downspouts.length} downspouts, ${snapshot.stats.eaveLF} LF, ` +
      `$${(snapshot.estimateTotalCents / 100).toFixed(0)}\nsource: ${sourceNote}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
