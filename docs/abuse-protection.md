# Abuse protection: rate limiting, quotas, and spend guards

Shipped 2026-07-10. This doc is the threat model, the architecture, the default
thresholds, and the runbook. Everything described here is implemented — file
paths are given per section.

## Threat model

GutterScan's exposure, ranked by expected damage:

| # | Threat | Surface | Worst case without guards |
|---|--------|---------|---------------------------|
| 1 | **Bot-driven LLM cost explosion** | `POST /api/blueprints`, `POST /api/blueprints/[id]/reanalyze` (3× Opus reads + Haiku + optional Gemini + per-face reads, `maxDuration=300`), `runEstimate` server action (Google Solar + SAM-2 + GPT-4o) | A scripted account loops uploads: **hundreds of dollars/hour** of Anthropic/OpenAI/Google spend on one stolen or trial account |
| 2 | **Credit-wallet bypass economics** | `runEstimate` re-run of same address is free within 24h; failed pipelines never debited | Bot fishes with junk addresses → unlimited free Solar/SAM-2/geocode calls |
| 3 | **Unauthenticated portal writes** | `/p/[token]` server actions: `acceptProposalByToken`, `respondToChangeOrder` — both mutate contract state and **email the contractor** | Token holder (or leaked link) loops writes → email spam from our domain, contract-state churn |
| 4 | **Email reputation burn** | Every Resend send: proposal send, receipts, reminders, worker invites, portal-triggered notifications | Compromised account or bot loop torches the sending domain's reputation + Resend bill |
| 5 | **Request floods / scraping** | `/api/leads` (3-query bbox reads, works per map-pan), all public pages, webhook/cron endpoints (secret brute-force) | DB saturation, Vercel function-hours bill, permit-lead dataset scraping |
| 6 | **Storage stockpiling** | `/api/blueprints/presign`, `/api/blueprints/upload-url` — mint 50 MB Blob upload capabilities | Blob storage bill growth |

Not in scope (already handled elsewhere): tenancy/IDOR (audited separately),
Stripe webhook forgery (signature-verified), cron auth (CRON_SECRET, fails closed).

## Recommended architecture: three layers

```
Internet
   │
   ▼
[Layer 0] Vercel platform — WAF managed rules, Attack Challenge Mode, Spend Mgmt
   │           (dashboard config, no code — see Rollout)
   ▼
[Layer 1] middleware.ts — in-memory per-IP limits at the edge
   │           burst + per-minute by route class, 3 strikes → 15-min ban
   ▼
[Layer 2] lib/abuse/* — durable Postgres counters inside handlers/actions
   │           per-user / per-token / per-recipient quotas (burst + sustained)
   ▼
[Layer 3] lib/abuse/spend-guard.ts — cost-aware caps + circuit breaker
              per-user daily $, global hourly/daily $ → circuit opens, admins alerted
```

Layer 1 is a flood-dampener; it is **per-isolate** (resets on deploy, not shared
across regions) and is deliberately not trusted for quotas. Layers 2–3 are the
durable system of record.

## Middleware / gateway placement

`middleware.ts` — the limiter runs **before** Clerk auth inside the existing
`clerkMiddleware` callback, on every matched route. Route classes and per-IP
per-minute limits:

| Class | Paths | Limit/min | Rationale |
|---|---|---|---|
| portal | `/p/*` | 40 | anonymous, bot-probed |
| webhook | `/api/webhooks/*` | 120 | Stripe retries are modest; more = secret brute force |
| cron | `/api/cron/*` | 30 | Vercel cron is 1/day |
| anon pages | `/`, `/sign-in*`, `/sign-up*`, `/demo*` | 60 | Clerk bot detection stacks on top |
| api | `/api/*` (signed-in) | 240 | catches floods only |
| app | everything else | 300 | catches floods only |

Plus a cross-class burst limit (80 req/10 s/IP) and a strike system: 3 limit
trips within 10 minutes → 15-minute IP ban. Responses are `429` with
`Retry-After`.

## Storage choice for counters and quotas

**Postgres (Neon), via Prisma — no Redis.** Reasons:

- The stack has no Redis today; adding Upstash means new creds, a new failure
  domain, and cold-start config for marginal gain at this traffic level.
- Every durable limit guards an action that costs 100 ms–120 s anyway; one
  indexed `INSERT … ON CONFLICT` upsert (~5–15 ms on Neon) is noise.
- Fixed-window buckets: one row per (policy, identity, window), key
  `"<policy>|<identity>|<windowSec>|<windowStart>"`, atomic increment via
  Prisma upsert. Swept daily by cron.
- **Upgrade path**: if traffic outgrows this, swap the body of
  `consumeLimit()` in `lib/abuse/rate-limit.ts` for `@upstash/ratelimit` —
  the policy table and every call site stay unchanged.

Tables (`prisma/migrations/20260710000000_abuse_protection`, idempotent SQL):
`rate_limit_buckets`, `spend_events` (cost ledger), `abuse_events` (audit).

## Suggested thresholds by endpoint type

All request-count policies live in `lib/abuse/policies.ts`, each overridable
via env `ABUSE_LIMIT_<NAME>="count/windowSec,count/windowSec"`. Defaults:

| Policy | Identity | Burst | Sustained | Fail mode |
|---|---|---|---|---|
| `estimate.run` | user | 10/hr | 30/day | **closed** |
| `blueprint.analyze` | user | 4/hr | 12/day | **closed** |
| `blueprint.upload` (presign + upload-url) | user | 20/hr | 60/day | open |
| `leads.query` | user (or IP if anon) | 120/min | — | open |
| `email.user` (proposal/reminder/receipt/CO/invite sends) | user | 20/hr | 100/day | **closed** |
| `email.recipient` (chokepoint in resend.ts) | recipient addr | 20/day | — | open |
| `email.global` (chokepoint in resend.ts) | platform | 500/day | — | open |
| `portal.accept` | proposal token | 5/day | — | open |
| `portal.changeorder` | proposal token | 10/day | — | open |
| `portal.ip` (all portal writes) | IP | 30/hr | — | open |

Spend caps (cents, env-overridable):

| Cap | Default | Env |
|---|---|---|
| Per-user daily AI spend | $20 | `ABUSE_USER_DAILY_AI_CENTS` |
| Global hourly AI spend | $30 | `ABUSE_GLOBAL_HOURLY_AI_CENTS` |
| Global daily AI spend | $100 | `ABUSE_GLOBAL_DAILY_AI_CENTS` |

Flat cost estimates for the pre-flight check (corrected to token-derived
actuals where usage is captured): satellite 25¢, blueprint 150¢ (floor — actual
Opus token math can exceed it), lead sync 50¢. `SUPER_ADMIN` bypasses
*per-user* limits only; the circuit and global caps apply to everyone.

## Code map

| Concern | File |
|---|---|
| Policy table + spend caps + cost estimates | `lib/abuse/policies.ts` |
| Postgres fixed-window limiter, abuse-event log, IP helpers | `lib/abuse/rate-limit.ts` |
| Spend ledger, per-user/global caps, circuit breaker | `lib/abuse/spend-guard.ts` |
| Composition guards (email budget, portal writes) | `lib/abuse/guards.ts` |
| Throttled admin alert emails | `lib/abuse/alerts.ts` |
| Edge per-IP limiter + bans | `middleware.ts` |
| Email chokepoint caps (recipient + global) | `lib/email/resend.ts` |
| Wire-ins | `app/actions/estimate.ts`, `app/api/blueprints/route.ts`, `app/api/blueprints/[id]/reanalyze/route.ts`, `app/api/blueprints/presign/route.ts`, `app/api/blueprints/upload-url/route.ts`, `app/api/leads/route.ts`, `app/actions/proposals.ts`, `app/actions/payments.ts`, `app/actions/workers.ts`, `app/api/cron/sync-leads/route.ts`, `app/api/admin/sync-leads-now/route.ts` |
| Counter sweep + event retention | `app/api/cron/payment-reminders/route.ts` (piggybacked daily) |
| Admin dashboard + circuit controls | `app/admin/abuse/page.tsx`, `app/actions/abuse.ts`, `components/admin/circuit-toggle.tsx` |

## Protect against bot-driven cost explosion

The design assumption: **any single control will eventually be bypassed**, so
cost safety is five stacked controls, each capping the blast radius of the one
above it:

1. **Request-rate limits on expensive endpoints** (`estimate.run`,
   `blueprint.analyze`) bound *attempts*: even with unlimited credits, one
   account gets ≤ 4 blueprint runs/hour, ≤ 10 estimates/hour. These fail
   **closed** — if the limiter can't count, the expensive action doesn't run.
2. **The spend ledger** (`spend_events`) records every AI action — including
   **failed** runs (a bot fishing with junk addresses still burns Solar/SAM-2
   calls, so failures are ledgered too) — with token-derived actuals where the
   pipeline captures usage.
3. **Per-user daily dollar cap** ($20): a stolen session or purchased account
   hits a hard ceiling regardless of which endpoints it mixes.
4. **Global hourly/daily dollar caps** ($30/$100): a *fleet* of accounts hits
   the platform ceiling. Crossing either **opens the circuit breaker** — a
   `PlatformSetting` flag every AI entry point checks first. Once open, all AI
   endpoints return a friendly "paused" message until an admin closes it at
   `/admin/abuse` (or sets `ABUSE_AI_DISABLED=0`… the env override
   `ABUSE_AI_DISABLED=1` also force-opens it for incidents).
5. **Alerting**: 80% of daily cap → warning email; cap crossed → circuit-open
   email; per-user cap hit → email naming the user. All throttled to 1/kind/hour.

Worst-case bound with defaults: an attack that defeats layers 1–3 entirely
still stops at ~$30 in the first hour / ~$100 in a day, and admins have been
emailed twice before that. Email abuse is separately bounded (20/recipient/day,
500/platform/day) so the bill *and* the sender reputation survive.

The same applies to money-adjacent surfaces that aren't LLMs: Blob presigns
are metered, lead syncs are ledgered, and cron/webhook endpoints are
IP-limited against secret brute-forcing.

## Rollout plan

Phase 0 — already live in this change (no config needed):
1. Deploy. `prisma migrate deploy` applies `20260710000000_abuse_protection`
   automatically (build script). Local branches: `npx prisma db execute --file
   prisma/migrations/20260710000000_abuse_protection/migration.sql` (idempotent).
2. Verify `ADMIN_EMAILS` is set in prod — it drives both admin access and alerts.
3. Visit `/admin/abuse`, confirm the page renders and the circuit is closed.

Phase 1 — platform config (Vercel dashboard, ~15 min):
4. Enable **Vercel WAF** managed rules for the production domain; keep
   **Attack Challenge Mode** one click away for active incidents.
5. Set **Vercel Spend Management** alerts + hard pause threshold.
6. In Clerk dashboard, confirm **bot protection** on sign-up (blocks scripted
   account creation upstream of everything here).
7. Set **usage alerts** in the Anthropic, OpenAI, and Google Cloud consoles as
   provider-side backstops (our caps are estimates; theirs are ground truth).

Phase 2 — tune after 2 weeks of real data:
8. Review `/admin/abuse` weekly: if `RATE_LIMITED` events are hitting real
   contractors, raise that policy via its `ABUSE_LIMIT_*` env; if spend meters
   sit far below caps, tighten the caps.
9. If portal probing shows up (`portal.ip` events), add Cloudflare Turnstile
   to the `/p/[token]` accept form — the guard call site in
   `acceptProposalByToken` is where the token check would go.

## Monitoring and alerting plan

- **Dashboard**: `/admin/abuse` — circuit state + one-click open/close, spend
  meters vs caps (hour/day), spend by kind, top-10 spenders (24h), last 50
  abuse events, rate-limited count (24h), active policy table.
- **Email alerts** (to `ADMIN_EMAILS`, throttled 1/kind/hour): circuit opened,
  80% of daily spend cap, per-user cap hit, global email cap hit.
- **Logs**: every denial logs an `abuse_events` row (first denial per window +
  every 50th, so floods can't flood the log). Edge bans log
  `[edge-limit] banned <ip>` to Vercel function logs.
- **Retention**: buckets swept daily; abuse events kept 90 days; spend ledger
  kept 365 days (it doubles as a cost-per-feature dataset).

## Failure modes and safe defaults

| Failure | Behavior | Why |
|---|---|---|
| Postgres unreachable during a limit check | Expensive policies (`estimate.run`, `blueprint.analyze`, `email.user`) **block**; cheap ones (leads, portal, uploads, email chokepoint) **allow** | An outage must never mean unmetered spend; it also must never lock a homeowner out of accepting a proposal |
| Spend-guard aggregate query fails | AI action **blocked** ("try again in a minute") | Can't read the ledger ⇒ can't bound the bill |
| Circuit-flag read fails | Same as above (part of the same check) | — |
| Alert email fails | Logged, request proceeds | Alerting must never take down the triggering request |
| Ledger write (`recordSpend`) fails | Logged, request proceeds | The pre-flight check is the gate; the ledger is telemetry at that point |
| Edge maps reset (deploy / cold start) | Limits restart from zero per isolate | Layer 1 is best-effort by design; Layer 2 is durable |
| `ADMIN_EMAILS` unset | Alerts become `abuse_events` rows only, with a console warning | — |
| Clock-edge double window (fixed-window artifact) | Worst case 2× burst at a boundary | Paired burst+sustained rules keep the sustained rate honest |

## Known gaps / future work

- **No CAPTCHA yet** — Clerk covers sign-up; portal forms get Turnstile only
  if probing materializes (Phase 2.9).
- **Satellite pipeline cost is a flat estimate** (GPT-4o usage isn't captured
  in `lib/ai/vision.ts`); token-accurate ledgering there is a small follow-up.
- **Per-isolate edge limits** understate multi-region floods — that's Layer 0's
  job (Vercel WAF), not code.
- `EstimateRun.apiCostCents` column exists but is superseded by `spend_events`.
