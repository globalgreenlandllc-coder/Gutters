import { SocrataDataset } from "./socrata";
import { ArcgisDataset } from "./arcgis";

// Tiny helpers for the inevitable string-typed Socrata fields.
const num = (v: unknown): number => parseFloat(String(v));
const intOrUndef = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? undefined : n;
};

// Canonical project-kind vocabulary used across all cities so the map filter
// stays simple. Each adapter normalizes its city's permit-type text into one
// of these buckets.
export type ProjectKind =
  | "New Construction"
  | "Remodel/Addition"
  | "Tenant Improvement"
  | "Demolition"
  | "Other";

// Generic project-kind normalizer that handles the keyword variations seen
// across municipal permit feeds. City-specific helpers below delegate to it.
function normalizeGenericProjectKind(raw: unknown): ProjectKind | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const v = raw.toLowerCase().trim();
  if (
    v === "new" ||
    v === "nb" ||
    v === "bldg-new" ||
    v.includes("new construction") ||
    (v.includes("new") && (v.includes("building") || v.includes("structure")))
  ) {
    return "New Construction";
  }
  if (v.includes("tenant")) return "Tenant Improvement";
  if (
    v.includes("demoli") ||
    v === "dm" ||
    v.includes("wrecking") ||
    v.includes("deconstruction")
  ) {
    return "Demolition";
  }
  if (
    v.includes("addition") ||
    v.includes("alteration") ||
    v.includes("remodel") ||
    v.includes("renovation") ||
    v.includes("repair") ||
    /^a[123]$/i.test(raw)
  ) {
    return "Remodel/Addition";
  }
  return "Other";
}

// ─── Seattle ─────────────────────────────────────────────────────────────────
function normalizeSeattlePermitType(raw: unknown): ProjectKind | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "new") return "New Construction";
  if (v.includes("addition") || v.includes("alteration")) return "Remodel/Addition";
  if (v.includes("tenant")) return "Tenant Improvement";
  if (v.includes("demoli") || v.includes("deconstruction")) return "Demolition";
  return "Other";
}

export const seattleDataset: SocrataDataset = {
  city: "Seattle",
  endpoint: "https://data.seattle.gov/resource/76t5-zqzr.json",
  where: "issueddate IS NOT NULL AND latitude IS NOT NULL",
  orderBy: "issueddate DESC",
  fields: {
    sourceId: (i) => i.permitnum,
    address: (i) => i.originaladdress1 ?? i.address ?? "Unknown Address",
    description: (i) => i.description ?? "No description provided",
    status: (i) => i.statuscurrent ?? "Issued",
    latitude: (i) => num(i.latitude),
    longitude: (i) => num(i.longitude),
    value: (i) => intOrUndef(i.estprojectcost),
    buildingType: (i) => i.permitclass ?? i.permitclassmapped,
    contractorName: (i) => i.contractorcompanyname,
    projectKind: (i) => normalizeSeattlePermitType(i.permittypedesc),
  },
};

// ─── San Francisco ───────────────────────────────────────────────────────────
// Dataset: data.sfgov.org/resource/i98e-djp9 (Building Permits)
// Lat/lng come back as GeoJSON Point: location.coordinates = [lng, lat]
export const sanFranciscoDataset: SocrataDataset = {
  city: "San Francisco",
  endpoint: "https://data.sfgov.org/resource/i98e-djp9.json",
  where: "issued_date IS NOT NULL AND location IS NOT NULL",
  orderBy: "issued_date DESC",
  fields: {
    sourceId: (i) => i.permit_number,
    address: (i) =>
      [i.street_number, i.street_name, i.street_suffix].filter(Boolean).join(" ") ||
      "Unknown Address",
    description: (i) => i.description ?? "No description provided",
    status: (i) => i.status ?? "Issued",
    // GeoJSON Point: coordinates = [longitude, latitude]
    latitude: (i) => num(i.location?.coordinates?.[1] ?? i.latitude),
    longitude: (i) => num(i.location?.coordinates?.[0] ?? i.longitude),
    value: (i) => intOrUndef(i.estimated_cost ?? i.revised_cost),
    // Existing/proposed use is the closest signal for building type
    buildingType: (i) => i.proposed_use ?? i.existing_use,
    projectKind: (i) => normalizeGenericProjectKind(i.permit_type_definition),
  },
};

// ─── New York City ───────────────────────────────────────────────────────────
// Dataset: data.cityofnewyork.us/resource/ipu4-2q9a (DOB Permit Issuance via filings)
// Description is reconstructed from coded fields because the dataset has no
// free-text description field — but the upside is that it exposes permittee
// business name + phone, which is excellent contact data.
function normalizeNycJobType(raw: unknown): ProjectKind | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const v = raw.toUpperCase().trim();
  if (v === "NB") return "New Construction";
  if (v === "DM") return "Demolition";
  if (v === "A1" || v === "A2" || v === "A3") return "Remodel/Addition";
  return "Other";
}
export const newYorkDataset: SocrataDataset = {
  city: "New York",
  endpoint: "https://data.cityofnewyork.us/resource/ipu4-2q9a.json",
  where: "permit_status='ISSUED' AND gis_latitude IS NOT NULL",
  orderBy: "issuance_date DESC",
  fields: {
    sourceId: (i) =>
      i.permit_si_no ?? (i.job__ ? `${i.job__}-${i.permit_sequence__ ?? "01"}` : undefined),
    address: (i) =>
      [i.house__, i.street_name, i.borough].filter(Boolean).join(" ") || "Unknown Address",
    description: (i) => {
      const parts = [i.job_type, i.permit_type, i.permit_subtype, i.work_type]
        .filter(Boolean)
        .filter((v: string, idx: number, arr: string[]) => arr.indexOf(v) === idx);
      return parts.length ? `Job ${parts.join(" / ")}` : "No description provided";
    },
    status: (i) => i.permit_status ?? "ISSUED",
    latitude: (i) => num(i.gis_latitude),
    longitude: (i) => num(i.gis_longitude),
    buildingType: (i) =>
      i.residential === "YES" ? "Residential" : i.residential === "NO" ? "Non-Residential" : undefined,
    // Permittee business name is the contractor doing the work; license type
    // "GC" means general contractor — most valuable contact for gutter sub-bids.
    contractorName: (i) => i.permittee_s_business_name,
    projectKind: (i) => normalizeNycJobType(i.job_type),
  },
};

// ─── Chicago ─────────────────────────────────────────────────────────────────
// Dataset: data.cityofchicago.org/resource/ydr8-5enu (Building Permits)
function normalizeChicagoPermitType(raw: unknown): ProjectKind | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const v = raw.toUpperCase();
  if (v.includes("NEW CONSTRUCTION")) return "New Construction";
  if (v.includes("WRECKING") || v.includes("DEMOLI")) return "Demolition";
  if (v.includes("RENOVATION") || v.includes("ALTERATION") || v.includes("REPAIR")) {
    return "Remodel/Addition";
  }
  return "Other";
}
export const chicagoDataset: SocrataDataset = {
  city: "Chicago",
  endpoint: "https://data.cityofchicago.org/resource/ydr8-5enu.json",
  where: "issue_date IS NOT NULL AND latitude IS NOT NULL",
  orderBy: "issue_date DESC",
  fields: {
    sourceId: (i) => i.permit_,
    address: (i) =>
      [i.street_number, i.street_direction, i.street_name].filter(Boolean).join(" ") ||
      "Unknown Address",
    description: (i) => i.work_description ?? i.permit_type ?? "No description provided",
    status: (i) => i.permit_status ?? "Issued",
    latitude: (i) => num(i.latitude),
    longitude: (i) => num(i.longitude),
    value: (i) => intOrUndef(i.reported_cost),
    // permit_type is like "PERMIT - NEW CONSTRUCTION" / "PERMIT - SIGNS" — coarse
    // but the only building-class signal in this dataset.
    buildingType: (i) =>
      typeof i.permit_type === "string" ? i.permit_type.replace(/^PERMIT - /, "") : undefined,
    contractorName: (i) =>
      i.contact_1_name && i.contact_1_type && /CONTRACTOR/i.test(i.contact_1_type)
        ? i.contact_1_name
        : undefined,
    projectKind: (i) => normalizeChicagoPermitType(i.permit_type),
  },
};

// ─── Los Angeles (DISABLED) ──────────────────────────────────────────────────
// Dataset: data.lacity.org/resource/xnhu-aczu (LA Build Permits)
// This dataset has detailed permit data — including contractor name, license,
// applicant — but does NOT publish lat/lng. To map LA leads we'd need to
// geocode addresses via Google Maps API (~$5/1k). Left disabled until that
// pipeline is built. Keep config so it's a one-line flip when ready.
export const losAngelesDataset: SocrataDataset = {
  city: "Los Angeles",
  endpoint: "https://data.lacity.org/resource/xnhu-aczu.json",
  where: "issue_date IS NOT NULL",
  orderBy: "issue_date DESC",
  fields: {
    sourceId: (i) => i.pcis_permit,
    address: (i) =>
      [i.address_start, i.street_direction, i.street_name, i.street_suffix]
        .filter(Boolean)
        .join(" ") || "Unknown Address",
    description: (i) => i.work_description ?? "No description provided",
    status: (i) => i.latest_status ?? "Issued",
    // No native geo — would need geocoding pipeline.
    latitude: () => NaN,
    longitude: () => NaN,
    value: (i) => intOrUndef(i.valuation),
    buildingType: (i) => i.permit_sub_type,
    contractorName: (i) => i.contractors_business_name,
    projectKind: (i) => normalizeGenericProjectKind(i.permit_type),
  },
};

// ─── Pierce County, WA (Tacoma area) ────────────────────────────────────────
// Dataset: open.piercecountywa.gov/resource/rcj9-mkn4 (Pierce County permits)
// Lat/lng come back as GeoJSON Point on `the_geom` field.
// Filter to construction-only — the raw feed includes plumbing, mechanical,
// signs, driveway, alarms etc. that aren't gutter opportunities.
function normalizePiercePermitType(rawType: unknown): string | undefined {
  if (typeof rawType !== "string") return undefined;
  if (rawType.includes("Residential")) return "Residential";
  if (rawType.includes("Commercial")) return "Commercial";
  return rawType;
}
export const pierceCountyDataset: SocrataDataset = {
  city: "Pierce County",
  endpoint: "https://open.piercecountywa.gov/resource/rcj9-mkn4.json",
  where:
    "applicationtype IN ('Construction Residential', 'Construction Commercial') AND issueddate IS NOT NULL AND the_geom IS NOT NULL",
  orderBy: "issueddate DESC",
  fields: {
    sourceId: (i) => i.applicationnumber,
    address: (i) => i.siteaddress ?? "Unknown Address",
    description: (i) => i.workdescription ?? "No description provided",
    status: (i) => i.applicationstatus ?? "Issued",
    latitude: (i) => num(i.the_geom?.coordinates?.[1]),
    longitude: (i) => num(i.the_geom?.coordinates?.[0]),
    value: (i) => intOrUndef(i.buildingvaluation),
    buildingType: (i) => normalizePiercePermitType(i.applicationtype),
    projectKind: (i) => normalizeGenericProjectKind(i.worktype),
  },
};

// ─── Austin ──────────────────────────────────────────────────────────────────
// Dataset: data.austintexas.gov/resource/3syk-w9eu (Issued Construction Permits)
function normalizeAustinWorkClass(raw: unknown): ProjectKind | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "new") return "New Construction";
  if (v === "remodel" || v === "addition" || v === "addition and remodel" || v.includes("repair")) {
    return "Remodel/Addition";
  }
  if (v.includes("tenant")) return "Tenant Improvement";
  if (v.includes("demoli")) return "Demolition";
  return "Other";
}
export const austinDataset: SocrataDataset = {
  city: "Austin",
  endpoint: "https://data.austintexas.gov/resource/3syk-w9eu.json",
  where: "issue_date IS NOT NULL AND latitude IS NOT NULL",
  orderBy: "issue_date DESC",
  fields: {
    sourceId: (i) => i.permit_number,
    address: (i) => i.original_address1 ?? i.permit_location ?? "Unknown Address",
    description: (i) => i.description ?? "No description provided",
    status: (i) => i.status_current ?? "Active",
    latitude: (i) => num(i.latitude),
    longitude: (i) => num(i.longitude),
    value: (i) => intOrUndef(i.total_job_valuation),
    buildingType: (i) => i.permit_class_mapped ?? i.permit_class,
    contractorName: (i) => i.contractor_company_name ?? i.applicant_org,
    projectKind: (i) => normalizeAustinWorkClass(i.work_class),
  },
};

// ─── Tacoma, WA (ArcGIS) ─────────────────────────────────────────────────────
// City of Tacoma publishes Accela permit data through ArcGIS Hub.
export const tacomaDataset: ArcgisDataset = {
  city: "Tacoma",
  layerUrl:
    "https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/accela_permit_data/FeatureServer/0",
  where: "issued_date IS NOT NULL",
  orderBy: "issued_date DESC",
  fields: {
    sourceId: (i) => i.permit_number,
    address: (i) =>
      [i.address_line_1, i.address_line_2].filter(Boolean).join(", ") || "Unknown Address",
    description: (i) => i.description ?? "No description provided",
    status: (i) => i.current_status ?? "Issued",
    latitude: (i) => num(i.latitude),
    longitude: (i) => num(i.longitude),
    value: (i) => intOrUndef(i.valuation),
    // permit_type is "Site"/"Building"/etc. — coarse but the only signal.
    buildingType: (i) => i.permit_type,
    contractorName: (i) =>
      i.applicant_name && i.applicant_name !== "No Primary Applicant Available"
        ? i.applicant_name
        : undefined,
    projectKind: (i) => normalizeGenericProjectKind(i.permit_subtype),
  },
};

// ─── Spokane County, WA (ArcGIS) ─────────────────────────────────────────────
// County-wide feed; covers Spokane City + outlying areas.
function classifySpokanePermitType(rawType: unknown): string | undefined {
  if (typeof rawType !== "string" || !rawType) return undefined;
  if (/^residential/i.test(rawType)) return "Residential";
  if (/^commercial/i.test(rawType)) return "Commercial";
  return rawType;
}
function classifySpokaneProjectKind(rawType: unknown): string | undefined {
  if (typeof rawType !== "string") return undefined;
  const v = rawType.toLowerCase();
  if (v.includes("new")) return "New Construction";
  if (v.includes("accessory") || v.includes("addition") || v.includes("alteration")) {
    return "Remodel/Addition";
  }
  if (v.includes("demoli")) return "Demolition";
  if (v.includes("tenant")) return "Tenant Improvement";
  return "Other";
}
export const spokaneCountyDataset: ArcgisDataset = {
  city: "Spokane County",
  layerUrl:
    "https://services3.arcgis.com/WlYQgAChrqj0tuQi/arcgis/rest/services/Spokane_County_Building_and_Planning_Permits/FeatureServer/0",
  where: "Issued_Date IS NOT NULL",
  orderBy: "Issued_Date DESC",
  fields: {
    sourceId: (i) => i.Permit_Number,
    address: (i) => i.Site_Address ?? "Unknown Address",
    description: (i) => i.Project_Description ?? "No description provided",
    status: (i) => i.Status_Description ?? i.Status ?? "Issued",
    // Lat/lng only available via geometry — adapter falls back automatically.
    buildingType: (i) => classifySpokanePermitType(i.Permit_Type),
    projectKind: (i) => classifySpokaneProjectKind(i.Permit_Type),
  },
};

// Registry — flip the `enabled` flag on each city to turn it on. Disabled
// ones don't get fetched by the cron, but the config stays here for easy
// re-enabling once you've verified its field names against the live API.
export interface SocrataRegistryEntry {
  kind: "socrata";
  dataset: SocrataDataset;
  enabled: boolean;
  limit: number;
}
export interface ArcgisRegistryEntry {
  kind: "arcgis";
  dataset: ArcgisDataset;
  enabled: boolean;
  limit: number;
}
export type RegistryEntry = SocrataRegistryEntry | ArcgisRegistryEntry;

export const cityRegistry: RegistryEntry[] = [
  // ─── Washington State ─────────────────────────────────────────────────
  { kind: "socrata", dataset: seattleDataset, enabled: true, limit: 50 },
  { kind: "socrata", dataset: pierceCountyDataset, enabled: true, limit: 50 },
  { kind: "arcgis", dataset: tacomaDataset, enabled: true, limit: 50 },
  { kind: "arcgis", dataset: spokaneCountyDataset, enabled: true, limit: 50 },
  //
  // ─── Other US metros ─────────────────────────────────────────────────
  { kind: "socrata", dataset: sanFranciscoDataset, enabled: true, limit: 50 },
  { kind: "socrata", dataset: newYorkDataset, enabled: true, limit: 50 },
  { kind: "socrata", dataset: chicagoDataset, enabled: true, limit: 50 },
  { kind: "socrata", dataset: austinDataset, enabled: true, limit: 50 },
  // LA needs a geocoding pipeline before it can plot pins — see comment above.
  { kind: "socrata", dataset: losAngelesDataset, enabled: false, limit: 50 },
];
