import { NextResponse } from "next/server";
import { runLeadsSync } from "@/lib/leads/run-sync";

// Vercel free/pro tier default function timeout is 10s; cron jobs and
// the admin "Sync now" button both rely on this longer budget since
// fetching + classifying permits across ~12 city feeds takes 60–90s.
export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runLeadsSync();
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("[Sync Worker] Error:", error);
    const message = error instanceof Error ? error.message : "sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
