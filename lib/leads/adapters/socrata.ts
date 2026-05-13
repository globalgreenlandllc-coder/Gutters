import { normalizePermitDescription } from "../ai-normalizer";

// A standardized interface for any permit data we pull
export interface RawPermitData {
  sourceId: string;
  sourceCity: string;
  address: string;
  originalDescription: string;
  status: string;
  latitude: number;
  longitude: number;
  projectValue?: number;
}

// Example: Seattle Building Permits via Socrata
// Endpoint: https://data.seattle.gov/resource/76t5-zqzr.json
// Note: In a real production app, you might want to use a Socrata App Token to avoid rate limits.
export async function fetchSocrataPermits(limit: number = 50): Promise<RawPermitData[]> {
  try {
    // We are querying permits from the last few days to find new ones, limiting for demo
    const url = `https://data.seattle.gov/resource/76t5-zqzr.json?$limit=${limit}&$order=issue_date DESC`;
    
    const response = await fetch(url, {
      // headers: { "X-App-Token": process.env.SOCRATA_APP_TOKEN || "" }
    });

    if (!response.ok) {
      console.error("Failed to fetch Socrata permits", response.status);
      return [];
    }

    const data = await response.json();

    const permits: RawPermitData[] = [];

    for (const item of data) {
      // Socrata JSON mapping depends on the specific dataset.
      // For Seattle's building permits, fields typically look like:
      // permitnum, originaladdress1, description, statuscurrent, latitude, longitude, value
      
      const sourceId = item.permitnum;
      const address = item.originaladdress1 || item.address || "Unknown Address";
      const originalDescription = item.description || "No description provided";
      const status = item.statuscurrent || "UNKNOWN";
      
      const lat = parseFloat(item.latitude);
      const lng = parseFloat(item.longitude);
      
      const projectValue = item.value ? parseInt(item.value, 10) : undefined;

      // Skip invalid coordinates
      if (!sourceId || isNaN(lat) || isNaN(lng)) {
        continue;
      }

      permits.push({
        sourceId,
        sourceCity: "Seattle", // Hardcoded for this specific dataset
        address,
        originalDescription,
        status,
        latitude: lat,
        longitude: lng,
        projectValue,
      });
    }

    return permits;
  } catch (error) {
    console.error("Socrata Adapter Error:", error);
    return [];
  }
}
