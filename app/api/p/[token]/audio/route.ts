import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getActiveApiKey } from "@/lib/api-keys";
import {
  buildProposalAudioScript,
  audioScriptHash,
} from "@/lib/proposal-audio-script";
import { checkPortalWrite } from "@/lib/abuse/guards";
import { POLICIES } from "@/lib/abuse/policies";
import { requestIp } from "@/lib/abuse/rate-limit";
import type { Proposal } from "@/lib/proposal-mock";

// Spoken summary of the proposal for the client portal's "Listen"
// button. Generated lazily on the first play (most proposals are never
// listened to, and the price can still move via discount negotiation
// after sending) and cached in Vercel Blob keyed by a hash of the
// script text — a price change flips the hash and the next play
// regenerates with the new numbers. Replays are a DB read + JSON
// response; only cache misses spend TTS money, so only they are
// rate-limited.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTS_VOICE = "nova";
const TTS_INSTRUCTIONS =
  "Warm, friendly, and professional — a contractor's assistant reading a " +
  "written quote to a homeowner who is listening in the car. Easy pace, " +
  "speak the prices clearly.";

// Best model first, but OpenAI project keys can restrict the model list
// (ours 403s `model_not_found` on gpt-4o-mini-tts) — fall through to the
// classic tts-1, which every project has. `instructions` is only
// supported by the gpt-4o-* speech models, so it's per-candidate.
const TTS_CANDIDATES: Array<{ model: string; instructions?: string }> = [
  { model: "gpt-4o-mini-tts", instructions: TTS_INSTRUCTIONS },
  { model: "tts-1" },
];

export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!token || token.length < 3) {
    return NextResponse.json(
      { ok: false, reason: "Proposal not found" },
      { status: 404 },
    );
  }

  const row = await db.proposal.findUnique({ where: { publicToken: token } });
  if (!row) {
    return NextResponse.json(
      { ok: false, reason: "Proposal not found" },
      { status: 404 },
    );
  }

  let script: string;
  try {
    script = buildProposalAudioScript(row.data as unknown as Proposal);
  } catch (e) {
    console.error("[proposal-audio] script build failed", e);
    return NextResponse.json(
      { ok: false, reason: "This proposal can't be summarized as audio." },
      { status: 422 },
    );
  }
  const hash = audioScriptHash(script);

  // Cache hit: the stored audio was generated from this exact script.
  if (row.audioUrl && row.audioScriptHash === hash) {
    await logListened(row.id, request, true);
    return NextResponse.json({ ok: true, url: row.audioUrl });
  }

  // Cache miss — about to spend real TTS money on an unauthenticated
  // route, so per-token + per-IP limits apply here and only here.
  const guard = await checkPortalWrite(
    POLICIES.portalAudio,
    token,
    "proposalAudio",
  );
  if (!guard.ok) {
    return NextResponse.json(
      { ok: false, reason: guard.reason },
      { status: 429, headers: { "Retry-After": String(guard.retryAfterSec) } },
    );
  }

  const apiKey =
    (await getActiveApiKey("OPENAI")) ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, reason: "Audio isn't set up yet — please read the proposal instead." },
      { status: 503 },
    );
  }

  let audio: Buffer | null = null;
  for (const candidate of TTS_CANDIDATES) {
    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: candidate.model,
        voice: TTS_VOICE,
        input: script,
        ...(candidate.instructions
          ? { instructions: candidate.instructions }
          : {}),
        response_format: "mp3",
      }),
    });
    if (ttsRes.ok) {
      audio = Buffer.from(await ttsRes.arrayBuffer());
      break;
    }
    const detail = await ttsRes.text().catch(() => "");
    console.error(
      `[proposal-audio] TTS failed (${ttsRes.status}, ${candidate.model})`,
      detail.slice(0, 500),
    );
    // Only a model-access rejection is worth retrying on the next
    // candidate — a bad key / quota error will fail them all the same.
    if (!detail.includes("model_not_found")) break;
  }
  if (!audio) {
    return NextResponse.json(
      { ok: false, reason: "Couldn't prepare the audio right now — please try again in a minute." },
      { status: 502 },
    );
  }

  // addRandomSuffix keeps the public blob URL unguessable — same trust
  // model as the portal token itself.
  const blob = await put(`proposal-audio/${row.id}/${hash}.mp3`, audio, {
    access: "public",
    contentType: "audio/mpeg",
    addRandomSuffix: true,
  });

  // Two simultaneous first-plays can both generate; last write wins and
  // the loser's blob is orphaned — harmless at ~200 KB, not worth a lock.
  const stale = row.audioUrl;
  await db.proposal.update({
    where: { id: row.id },
    data: { audioUrl: blob.url, audioScriptHash: hash },
  });
  if (stale && stale !== blob.url) {
    try {
      await del(stale);
    } catch {
      // best-effort cleanup — an orphaned old file is fine
    }
  }

  await logListened(row.id, request, false);
  return NextResponse.json({ ok: true, url: blob.url });
}

/** Best-effort LISTENED event — analytics must never fail the play. */
async function logListened(
  proposalId: string,
  request: Request,
  cached: boolean,
): Promise<void> {
  try {
    await db.proposalEvent.create({
      data: {
        proposalId,
        kind: "LISTENED",
        ipAddress: requestIp(request),
        userAgent: request.headers.get("user-agent"),
        payload: { cached } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // ignore
  }
}
