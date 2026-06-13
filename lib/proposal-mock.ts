import type {
  Downspout,
  EditableLine,
  EstimateConfig,
  LineItem,
  Measurements,
  RoofStructure,
} from "./types";
import { buildLineItems } from "./pricing";
import { sampleMeasurements } from "./mock-estimate";

export type PackageId = "good" | "better" | "best";

export type AddOn = {
  id: string;
  name: string;
  description?: string;
  price: number;
  included: boolean;
};

export type Package = {
  id: PackageId;
  name: string;
  tagline: string;
  config: EstimateConfig;
  highlights: string[];
  addOns: AddOn[];
  markupPct: number;
  recommended?: boolean;
  /** Per-line BOM tweaks keyed by the auto line id from `buildLineItems`
   *  (e.g. "gutter", "labor"). Lets the contractor override a quantity or
   *  unit price WITHOUT detaching the bill of materials from the live
   *  config — change the material and the un-overridden lines still
   *  refresh. Absent = pure auto BOM (the common case). */
  lineItemOverrides?: Record<
    string,
    { quantity?: number; unitPrice?: number }
  >;
  /** Hand-added BOM lines beyond the auto-generated system (custom
   *  fabrication, a one-off charge, etc.). */
  customLineItems?: LineItem[];
};

/**
 * Effective bill of materials for a package: the auto lines derived from
 * its config (with any per-line overrides applied) followed by the
 * contractor's custom lines. Single source of truth for both the
 * MaterialsBuilder BOM editor and `packageTotal` so the displayed lines
 * and the price can never disagree.
 */
export function packageLineItems(
  p: Package,
  measurements: Measurements,
): LineItem[] {
  const auto: LineItem[] = buildLineItems(measurements, p.config).map((it) => {
    const ov = p.lineItemOverrides?.[it.id];
    if (!ov) return it;
    return {
      ...it,
      quantity: ov.quantity ?? it.quantity,
      unitPrice: ov.unitPrice ?? it.unitPrice,
    };
  });
  return [...auto, ...(p.customLineItems ?? [])];
}

export type Photo = {
  id: string;
  caption: string;
  tone: "front" | "side" | "back" | "detail";
};

export type TermsBlock = {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
};

/** Live takeoff snapshot carried over from /estimate. Optional —
 *  proposals created from scratch (without going through the estimate
 *  flow) don't have it, and the aerial section falls back to a sample
 *  cartoon roof in that case. */
export type ProposalTakeoff = {
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
  /** Roof outline + ridge/hip/valley lines for the read-only overlay. */
  roofStructure?: RoofStructure;
  aerial?: {
    imageDataUrl: string;
    width: number;
    height: number;
    zoom: number;
  };
};

export type Proposal = {
  token: string;
  address: string;
  client: { name: string; email: string };
  contractor: {
    name: string;
    company: string;
    phone: string;
    email: string;
    license: string;
    stripePaymentUrl?: string | null;
    squarePaymentUrl?: string | null;
  };
  intro: string;
  measurements: Measurements;
  takeoff?: ProposalTakeoff;
  packages: Package[];
  photos: Photo[];
  terms: TermsBlock[];
  depositPct: number;
  validDays: number;
  /** Per-proposal discount applied to every package total. Stored as
   *  a percentage (0-50). 0 = no discount. Optional + defaulted to 0
   *  on load so older proposals without this field still render. */
  discountPct?: number;
  /** Free-form reason the contractor shows next to the discount so
   *  the homeowner sees WHY (e.g. 'Spring promo', 'Repeat customer'). */
  discountLabel?: string;
};

export const sampleProposal: Proposal = {
  token: "demo-7f3a2",
  address: "1247 Maple Ridge Drive, Austin, TX 78704",
  client: { name: "Sarah & Mike Chen", email: "sarah.chen@example.com" },
  contractor: {
    name: "Alex Rivera",
    company: "Rivera Gutterworks",
    phone: "(512) 555-0184",
    email: "alex@riveragutters.com",
    license: "TX-RCC-48217",
    stripePaymentUrl: "https://buy.stripe.com/test_demo_link",
    squarePaymentUrl: null,
  },
  intro:
    "Thanks for the opportunity to quote your gutter replacement. Below you'll find three package options sized to your roof, with detailed materials, labor, and a 1-click way to accept. Pricing is locked for 30 days.",
  measurements: sampleMeasurements,
  packages: [
    {
      id: "good",
      name: "Essential",
      tagline: "Solid protection at a great price",
      config: {
        size: "5",
        style: "k-style",
        material: "aluminum",
        color: "white",
        downspoutSize: "2x3",
      },
      highlights: [
        '5" K-style aluminum gutters',
        '2"×3" downspouts',
        "Hidden hangers, 24\" on center",
        "10-year workmanship warranty",
      ],
      addOns: [
        {
          id: "fascia",
          name: "Fascia board minor repair",
          description: "Up to 12 LF",
          price: 240,
          included: false,
        },
      ],
      markupPct: 12,
    },
    {
      id: "better",
      name: "Pro Shield",
      tagline: "Most popular — bigger profile and guards",
      config: {
        size: "6",
        style: "k-style",
        material: "aluminum",
        color: "graphite",
        downspoutSize: "3x4",
      },
      highlights: [
        '6" K-style aluminum gutters',
        '3"×4" oversized downspouts',
        "Micro-mesh gutter guards",
        "15-year workmanship warranty",
        "Annual inspection (year 1)",
      ],
      addOns: [
        {
          id: "guards",
          name: "Premium micro-mesh guards",
          description: "Stainless steel, full-length",
          price: 0,
          included: true,
        },
        {
          id: "drip-edge",
          name: "Aluminum drip edge",
          price: 320,
          included: false,
        },
      ],
      markupPct: 18,
      recommended: true,
    },
    {
      id: "best",
      name: "Heritage Copper",
      tagline: "Architectural-grade, lifetime patina",
      config: {
        size: "6",
        style: "half-round",
        material: "copper",
        color: "copper",
        downspoutSize: "round-4",
      },
      highlights: [
        '6" half-round natural copper',
        '4" round copper downspouts',
        "Solid copper hangers",
        "25-year workmanship + lifetime material",
        "White-glove install + post-storm checkup",
      ],
      addOns: [
        {
          id: "guards-cu",
          name: "Copper micro-mesh guards",
          price: 0,
          included: true,
        },
        {
          id: "rain-chains",
          name: "Decorative rain chains (×2)",
          price: 480,
          included: false,
        },
      ],
      markupPct: 22,
    },
  ],
  photos: [
    { id: "p1", caption: "Front facade — south exposure", tone: "front" },
    { id: "p2", caption: "Garage side — easy ladder access", tone: "side" },
    { id: "p3", caption: "Backyard tree overhang", tone: "back" },
    { id: "p4", caption: "Existing gutter wear (NW corner)", tone: "detail" },
  ],
  terms: [
    {
      id: "scope",
      title: "Scope of work",
      body: "Removal and disposal of existing gutters and downspouts. Installation of new seamless gutters, downspouts, hangers, end caps, and miters per the package selected. Includes site cleanup and magnetic sweep for fasteners.",
      enabled: true,
    },
    {
      id: "warranty",
      title: "Workmanship warranty",
      body: "Rivera Gutterworks warrants all installation labor for the period stated in the selected package. Material warranties pass through from manufacturer. Warranty is non-transferable except with prior written consent.",
      enabled: true,
    },
    {
      id: "payment",
      title: "Payment terms",
      body: "Deposit due at signing via secure Stripe link. Balance due upon substantial completion. Payments processed by Stripe; no card details are stored by Rivera Gutterworks.",
      enabled: true,
    },
    {
      id: "scheduling",
      title: "Scheduling & weather",
      body: "Install will be scheduled within 14 days of accepted proposal. Work is weather-dependent and may be rescheduled with 24-hour notice in the event of unsafe conditions.",
      enabled: true,
    },
    {
      id: "exclusions",
      title: "Exclusions",
      body: "Pricing excludes hidden rot, repairs to fascia or soffit greater than 12 LF, gutter guard replacement on non-installed sections, and any work requiring permits beyond standard residential.",
      enabled: false,
    },
  ],
  depositPct: 30,
  validDays: 30,
};

/**
 * Returns a clean starting state for a new proposal: contractor + client
 * fields blank, photos empty, but the package and terms libraries
 * pre-populated as starting templates the user can edit.
 *
 * Use this from /proposal when starting a fresh draft. The full
 * `sampleProposal` above is for the public /p/[token] demo and tests.
 */
export function blankProposal(): Proposal {
  return {
    token: `draft-${Math.random().toString(36).slice(2, 9)}`,
    address: "",
    client: { name: "", email: "" },
    contractor: {
      name: "",
      company: "",
      phone: "",
      email: "",
      license: "",
      stripePaymentUrl: null,
      squarePaymentUrl: null,
    },
    intro:
      "Thanks for the opportunity to quote your gutter project. Below you'll find package options sized to your roof, with detailed materials, labor, and a 1-click way to accept.",
    measurements: sampleMeasurements,
    packages: sampleProposal.packages.map((p) => ({
      ...p,
      addOns: p.addOns.map((a) => ({ ...a })),
    })),
    photos: [],
    terms: sampleProposal.terms.map((t) => ({ ...t })),
    depositPct: 30,
    validDays: 30,
  };
}

/** Effective sales-tax factor applied to the post-discount total. The
 *  0.85 fudge reflects the share of the job that's taxable material vs
 *  non-taxable labor. Exported so the inverse (`markupPctForTarget`)
 *  can't drift from the forward calc below. */
export const EFFECTIVE_TAX_RATE = 0.0825 * 0.85;

export function packageTotal(
  p: Package,
  measurements: Measurements,
  /** Per-proposal discount percentage (0-50). Applied AFTER markup,
   *  BEFORE tax — same order the estimate Summary already uses, so
   *  the dashboard / proposal / client portal all show the same
   *  number for a given package + discount combination. */
  discountPct: number = 0,
): {
  subtotal: number;
  total: number;
  addOns: number;
  discount: number;
} {
  const items = packageLineItems(p, measurements);
  const baseSubtotal = items.reduce(
    (acc, i) => acc + i.quantity * i.unitPrice,
    0,
  );
  const addOns = p.addOns.reduce(
    (acc, a) => acc + (a.included ? a.price : 0),
    0,
  );
  const subtotal = baseSubtotal + addOns;
  const markup = subtotal * (p.markupPct / 100);
  const afterMarkup = subtotal + markup;
  const safePct = Math.max(0, Math.min(50, discountPct));
  const discount = afterMarkup * (safePct / 100);
  const tax = (afterMarkup - discount) * EFFECTIVE_TAX_RATE;
  return {
    subtotal,
    addOns,
    discount,
    total: afterMarkup - discount + tax,
  };
}

/**
 * Inverse of `packageTotal`'s `total`. Given a sticker price the
 * contractor types in, return the `markupPct` that produces it at the
 * current subtotal + discount, so the editor can offer a "type any
 * price" field while markup stays the single stored knob. Derived from
 *   total = subtotal · (1 + m) · (1 − d) · (1 + EFFECTIVE_TAX_RATE)
 * solved for m. `subtotal` here is the package subtotal *including*
 * add-ons (the `subtotal` field `packageTotal` returns). Returns a
 * full-precision percentage so the typed total round-trips exactly;
 * round only for display. May go negative (selling below cost) — that's
 * the contractor's call, not ours to clamp.
 */
export function markupPctForTarget(
  targetTotal: number,
  subtotal: number,
  discountPct: number = 0,
): number {
  if (subtotal <= 0) return 0;
  const d = Math.max(0, Math.min(50, discountPct)) / 100;
  const ratio =
    targetTotal / (subtotal * (1 - d) * (1 + EFFECTIVE_TAX_RATE));
  return (ratio - 1) * 100;
}
