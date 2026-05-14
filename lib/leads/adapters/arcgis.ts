// Generic ArcGIS FeatureServer adapter. Most US municipalities that don't use
// Socrata publish permits through Esri/ArcGIS Hub, which exposes a standard
// `/query` endpoint per layer. This adapter normalizes those responses into
// the same RawPermitData shape that the Socrata adapter produces.

import { RawPermitData } from "./socrata";

export interface ArcgisDataset {
  city: string;
  // Full layer URL ending in `/FeatureServer/<layerId>` (no `/query`).
  layerUrl: string;
  // Optional WHERE clause in ArcGIS-flavored SQL. Default is "1=1" (no filter).
  where?: string;
  // Optional ORDER BY, e.g. "issued_date DESC".
  orderBy?: string;
  fields: {
    sourceId: (item: any) => string | undefined;
    address: (item: any) => string;
    description: (item: any) => string;
    status: (item: any) => string;
    // Both lat/lng are OPTIONAL — many ArcGIS layers expose geo only via
    // the Point geometry. The adapter falls back to geometry.coordinates.
    latitude?: (item: any) => number;
    longitude?: (item: any) => number;
    value?: (item: any) => number | undefined;
    buildingType?: (item: any) => string | undefined;
    contractorName?: (item: any) => string | undefined;
    projectKind?: (item: any) => string | undefined;
  };
}

export async function fetchArcgisPermits(
  dataset: ArcgisDataset,
  limit: number = 50,
): Promise<RawPermitData[]> {
  try {
    const url = new URL(`${dataset.layerUrl}/query`);
    url.searchParams.set("where", dataset.where ?? "1=1");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("resultRecordCount", String(limit));
    if (dataset.orderBy) url.searchParams.set("orderByFields", dataset.orderBy);
    url.searchParams.set("f", "geojson");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("returnGeometry", "true");

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`[ArcGIS:${dataset.city}] fetch failed (${response.status})`);
      return [];
    }

    const data = (await response.json()) as any;
    if (data?.error) {
      console.error(`[ArcGIS:${dataset.city}] API error:`, data.error?.message ?? data.error);
      return [];
    }
    const features: any[] = Array.isArray(data?.features) ? data.features : [];

    const permits: RawPermitData[] = [];
    for (const feature of features) {
      const props = feature?.properties ?? {};
      const geom = feature?.geometry ?? null;

      const propLat = dataset.fields.latitude?.(props);
      const propLng = dataset.fields.longitude?.(props);
      const lat =
        propLat != null && isFinite(propLat) ? propLat : geom?.coordinates?.[1];
      const lng =
        propLng != null && isFinite(propLng) ? propLng : geom?.coordinates?.[0];

      const sourceId = dataset.fields.sourceId(props);
      if (!sourceId || !isFinite(Number(lat)) || !isFinite(Number(lng))) continue;

      permits.push({
        sourceId,
        sourceCity: dataset.city,
        address: dataset.fields.address(props),
        originalDescription: dataset.fields.description(props),
        status: dataset.fields.status(props),
        latitude: Number(lat),
        longitude: Number(lng),
        projectValue: dataset.fields.value?.(props),
        buildingType: dataset.fields.buildingType?.(props),
        contractorName: dataset.fields.contractorName?.(props),
        projectKind: dataset.fields.projectKind?.(props),
      });
    }

    return permits;
  } catch (error) {
    console.error(`[ArcGIS:${dataset.city}] adapter error:`, error);
    return [];
  }
}
