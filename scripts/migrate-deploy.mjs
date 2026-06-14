#!/usr/bin/env node
/**
 * Resilient `prisma migrate deploy` for the Vercel build.
 *
 * Neon auto-suspends idle computes. A build's migrate step connects to the
 * DIRECT (unpooled) endpoint, and a cold compute can fail to answer within
 * Prisma's ~5s connect timeout → `P1001: Can't reach database server`,
 * which killed the deploy (see the build logs we hit during the outage).
 *
 * This wrapper retries the migrate on CONNECTIVITY errors only — the first
 * failed attempt is itself the wake-up call, so a subsequent retry lands
 * once Neon's compute is up. A genuine migration error (bad SQL, drift,
 * etc.) is NOT connectivity, so we fail fast on it and never mask it.
 *
 * No new env vars, no secrets — drop-in replacement for `prisma migrate
 * deploy` in the build script. Tunable via MIGRATE_MAX_ATTEMPTS /
 * MIGRATE_BACKOFF_MS if needed.
 */
import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = Math.max(1, Number(process.env.MIGRATE_MAX_ATTEMPTS) || 5);
const BACKOFF_MS = Math.max(0, Number(process.env.MIGRATE_BACKOFF_MS) || 4000);

// Substrings that mark a transient CONNECTIVITY failure (retry), as opposed
// to a real migration failure (fail fast). Prisma surfaces P1001/P1002 for
// unreachable/timed-out servers; the raw socket errors cover edge cases.
const RETRYABLE = [
  "P1001",
  "P1002",
  "Can't reach database server",
  "the database server",
  "timed out",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
];

function isRetryable(output) {
  return RETRYABLE.some((needle) => output.includes(needle));
}

// Synchronous sleep with no deps (keeps this a single-file, install-free
// build step). Blocks the thread for `ms`.
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const res = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    encoding: "utf8",
    env: process.env,
  });

  const output = (res.stdout || "") + (res.stderr || "");
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  if (res.status === 0) {
    if (attempt > 1) {
      console.log(
        `[migrate-deploy] succeeded on attempt ${attempt}/${MAX_ATTEMPTS}.`,
      );
    }
    process.exit(0);
  }

  // spawn itself failed (e.g. npx not found) — surface it, don't loop.
  if (res.error) {
    console.error(`[migrate-deploy] failed to launch prisma:`, res.error);
    process.exit(1);
  }

  if (!isRetryable(output)) {
    console.error(
      `[migrate-deploy] migration failed (not a connectivity error) — failing the build without retry.`,
    );
    process.exit(res.status || 1);
  }

  if (attempt < MAX_ATTEMPTS) {
    const wait = BACKOFF_MS * attempt; // linear: 4s, 8s, 12s, …
    console.error(
      `[migrate-deploy] database unreachable (attempt ${attempt}/${MAX_ATTEMPTS}) — Neon compute is likely cold. Retrying in ${wait}ms…`,
    );
    sleepSync(wait);
  }
}

console.error(
  `[migrate-deploy] database still unreachable after ${MAX_ATTEMPTS} attempts — failing the build.`,
);
process.exit(1);
