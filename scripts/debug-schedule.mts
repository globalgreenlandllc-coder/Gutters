/**
 * debug-schedule.mts — run parseRoofMasses + parseScheduleAreaFt2 over the REAL
 * plan set's page text (same path as blueprint-gates) to see why roofMasses came
 * through empty on the Woodinville re-analyze.
 * Run: npx tsx scripts/debug-schedule.mts
 */
import { readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";
import { parseRoofMasses, parseScheduleAreaFt2 } from "../lib/ai/to-masses.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pdf = await getDocumentProxy(new Uint8Array(readFileSync(PDF)));
for (let p = 1; p <= Math.min(pdf.numPages, 30); p++) {
  const page = await pdf.getPage(p);
  const content = await page.getTextContent();
  const text = (content.items as Array<{ str?: string }>).map((i) => i.str ?? "").join(" ");
  const masses = parseRoofMasses(text);
  const sched = parseScheduleAreaFt2(text);
  const ra = text.search(/roof\s*area/i);
  if (masses.length || sched || ra >= 0) {
    console.log(`page ${p}: textLen=${text.length} roofArea@${ra}`);
    if (ra >= 0) console.log(`  context: "${text.slice(Math.max(0, ra - 60), ra + 90).replace(/\s+/g, " ")}"`);
    if (masses.length) console.log(`  parseRoofMasses: ${masses.map((m) => `${m.label}=${m.areaFt2}`).join(", ")}`);
    if (sched) console.log(`  parseScheduleAreaFt2: ${sched.areaFt2} (${sched.label})`);
  }
}
