# Argmax Outreach

A Cloudflare Worker application for researching and qualifying prospective software clients, preparing evidence-backed personalized outreach, and dispatching approved campaigns.

It is intentionally safe by default: `SEND_MODE=dry_run`; no real email is possible until the email adapter is configured and `SEND_MODE=live` is explicitly set.

## What is included

- Companies, signals, contacts, policy state, qualification score, templates, campaigns, enrollments, outbox, event, suppression, and usage-ledger data models.
- API endpoints to ingest traceable signals, create/qualify contacts, import templates, create campaigns, review enrollments, schedule mail, ingest provider events, and inspect operational state.
- Automatic discovery: eight RSS feeds are bootstrapped on the first scheduled run, plus a ninth structured source (Y Combinator's public company directory — see "Startup discovery upgrade" below). They cover global funding news, regional funding queries, small-business growth cues, TechCrunch, EU-Startups, and YC. Each source is polled at most once every 12 hours, deduplicated, then put into the enrichment pipeline.
- A deterministic qualification gate: at least 75 points, need score of at least 15, a currently verified address, and an eligible policy decision.
- Frozen, evidence-backed template rendering. Missing or unapproved placeholders block scheduling.
- An outbox/idempotency design. A provider timeout is marked `send_unknown` and never automatically resent.
- Reply, unsubscribe, complaint, and hard-bounce events suppress the contact and cancel future steps.
- Queue-driven dispatch with a final check for suppression, reply-sync freshness, policy eligibility, campaign state, and send limits.
- Dependency-free unit tests for the business-critical gates, plus an end-to-end integration test (see "Testing" below).

## Startup discovery upgrade (this change)

This upgrade extends the platform in place — nothing above was rewritten — with the pluggable discovery, enrichment, research, and notification layer needed to run the pipeline in `OUTREACH_SYSTEM_PLAN.md` end to end for the "funded startups" track. It reuses the existing company/signal/contact/qualification/campaign/outbox architecture rather than introducing a parallel one.

**New capabilities:**

- **Pluggable discovery providers.** `discovery_sources.provider_type` now distinguishes `rss_headline` sources from `yc_directory`. A source can be listed, enabled, or disabled through the API without touching code (spec §7).
- **Y Combinator discovery provider.** Pulls the public, unofficial `yc-oss/api` mirror of YC's own Algolia-backed company directory (`https://yc-oss.github.io/api/companies/all.json`) — see [use-list/API--Y-Combinator-API](https://github.com/use-list/API--Y-Combinator-API). This is a daily-refreshed static JSON export, not a scraper: it doesn't touch ycombinator.com, bypass any access control, or require credentials. **This is a third-party, unofficial project outside Argmax's or Anthropic's control — verify it still meets your compliance bar before relying on it in production, or point `discovery_sources` at your own authorized YC data connector instead.** Because YC itself publishes the company's website in this feed, that domain is treated as sufficient evidence of company identity (no round-trip through `ENRICHMENT_API_URL` is required for YC records, unlike RSS headlines, which still need it).
- **Domain-based deduplication.** `normalizeDomain()` collapses `https://www.example.com/`, `http://example.com`, and `example.com` to the same key before any company lookup, so the same company can never be created twice from two sources.
- **Contact discovery from the company's own website.** A best-effort `ContactDiscoveryProvider` fetches the company's homepage and pulls out `mailto:` links the page itself published. It **never constructs or guesses an address** (no `first.last@domain` patterns). Every contact it finds starts at `verification_status = "pending"`, and the existing `canDispatch` gate already refuses anything that isn't `"valid"`, so nothing from this path can reach the send pipeline unverified. `LinkedIn` is intentionally not implemented as a scraper — see "Known limitations" below.
- **Contact verification state machine.** `nextVerificationState()` only allows the forward transitions in spec §12 (`unknown → pending → valid|invalid|risky|catch_all|disposable`); an out-of-order transition throws instead of silently succeeding.
- **Deterministic lead scoring + "why this lead" reasoning.** `scoreStartupSignals()` and `buildLeadReason()` compute an explainable score/rationale purely from stored, evidenced facts (a funding signal exists, hiring is on record, the product looks AI-related, a decision-maker is verified) — never from an AI guess. This is stored per company in the new `lead_reasons` and `research_reports` tables and is intentionally kept separate from, not a replacement for, the existing `qualificationDecision()` gate that a human still drives through `POST /api/qualifications`.
- **Research agent (deterministic today, pluggable for a real model later).** `POST /api/leads/:companyId/research` builds a structured report from only what's already in the database. Any field it can't support from stored evidence is reported as `"UNKNOWN"` rather than guessed. Free text pulled from an external source is passed through `sanitizeUntrustedText()` first — text that looks like it's trying to issue instructions to an AI system is dropped rather than quoted. See "Prompt-injection posture" below for what still needs to change before wiring in a live `AI_PROVIDER`.
- **Notifications and an activity feed.** `notifications` and `activity_events` tables, with a high-value-lead alert fired automatically when `scoreStartupSignals()` crosses `HIGH_VALUE_LEAD_THRESHOLD`, and reply/bounce/unsubscribe/discovery-error notifications wired into the existing webhook and discovery code paths.
- **Observability.** Every discovery execution (each RSS source, the YC provider, the funding-data provider adapter) now writes a `discovery_runs` row with counts and any error, per spec §29.
- **New read APIs**: `GET /api/companies`, `GET /api/companies/:id` (full profile: signals, contacts, qualification, research, lead reason, enrollments), `GET/POST /api/discovery/sources`, `GET /api/discovery/runs`, `POST /api/contacts/discover/:companyId`, `POST /api/leads/:companyId/research`, `GET /api/notifications`, `POST /api/notifications/:id/read`, `GET /api/activity`, `GET /api/reports/daily`. All existing endpoints are unchanged.

### Prompt-injection posture

`sanitizeUntrustedText()` flags obvious instruction-style patterns ("ignore previous instructions", "you are now...") in text pulled from an external source, and wraps anything that gets used in an `<untrusted_external_data>` block. This is defense-in-depth, not a guarantee — the real control is architectural: the research agent only ever emits fields that already exist as structured, evidenced rows in this database (a signal's `event_type`, a contact's stored `verification_status`), never free text lifted verbatim from a scraped page. If you wire in a real `AI_PROVIDER` later, keep that invariant: pass scraped text to the model only inside the wrapped/tagged block, in a role clearly separate from your system instructions, and only accept back fields that also correspond to something already stored — never let the model's output alone create a new fact.

### Bug fixed in this change

The original `DEFAULT_DISCOVERY_SOURCES` array literal was missing a comma between the small-business-growth entry and the TechCrunch entry. In JavaScript, `[...][...]` (two adjacent array literals with no operator) parses as *array-indexing*, not as two array elements — it silently turned the TechCrunch row into `undefined` and dropped the intended element entirely, which would have thrown inside `bootstrapSources` the first time the scheduled job ran discovery. This is fixed; a comma now separates every entry.


## Current automation boundary

After deployment, the Worker automatically fetches the default feeds and saves matching items as discovery candidates. It does **not** promise to find every funding round or every small business worldwide. Public news coverage varies by country, language, sector, and whether the company announces the event.

A candidate becomes a company record only when the configured enrichment service returns a verified official domain and supporting evidence. Contacts, policy decisions, templates, campaign activation, reply synchronization, and live email-provider integration also require configuration. Until then, no real messages are sent because the default `SEND_MODE` is `dry_run`.

## Before running real outreach

1. Populate a legally reviewed country/contact-policy table in the app or your source of truth. The sample API accepts an `eligible` decision but does not create it automatically.
2. Import your exact approved email template and an approved proof library. Do not use unsupported client claims.
3. Configure sender identity, postal address, privacy/opt-out details, mail provider API, provider event webhooks, and reply synchronization.
4. Create D1 and Queue resources; apply `schema.sql`; replace IDs in `wrangler.toml`.
5. Set secrets with Wrangler, including `ADMIN_TOKEN`, `WEBHOOK_SECRET`, sender identity, and provider credentials.
6. Run only controlled dry-run recipients first. Set `SEND_MODE=live` only after authentication, reply reconciliation, webhook tests, and the launch checks in the outreach plan pass.

## Local checks

```sh
npm test
npm run check
```

The default `npm test` runs the dependency-free unit tests (pure functions only — dedup, YC mapping, verification state machine, scoring, notification building, prompt-injection flagging), so it stays green on any Node version. For full end-to-end coverage of the wiring itself (discovery → company → signal → contact → research → notification → dashboard, run against a real in-memory SQLite database, not mocks), run:

```sh
node --test test/smoke.integration.test.js
```

This needs Node ≥ 22.5 (for the experimental `node:sqlite` module); it's skipped, not failed, on older versions.

## Deployment

Install Wrangler in your normal development environment, authenticate it to the Cloudflare account that will own the data, then create the managed resources:

```sh
npx wrangler d1 create argmax-outreach
npx wrangler queues create argmax-outreach
npx wrangler d1 execute argmax-outreach --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put SENDER_EMAIL
npx wrangler secret put SENDER_NAME
npx wrangler secret put SENDER_POSTAL_ADDRESS
npx wrangler deploy
```

Copy the returned D1 ID into `wrangler.toml` before the schema/deploy steps. Keep `SEND_MODE = "dry_run"` through controlled testing. The supplied cron asks the scheduler to enqueue due messages every five minutes; it still cannot dispatch messages from a paused/draft campaign or a stale reply-sync state.

### Upgrading an already-deployed database

If you already have a running `argmax-outreach` D1 database from before this change, do **not** re-run `schema.sql` against it (its `CREATE TABLE IF NOT EXISTS` statements won't add new columns to existing tables). Instead run whichever migrations you haven't applied yet, in order — each is idempotent and preserves existing rows:

```sh
npx wrangler d1 execute argmax-outreach --remote --file=migrations/0002_startup_discovery_upgrade.sql
npx wrangler d1 execute argmax-outreach --remote --file=migrations/0003_ai_notifications_export_upgrade.sql
```

A brand-new database should just use `schema.sql` directly; it already contains the full current schema.

### Automated discovery setup

Discovery starts after deployment when the scheduled job first runs. It seeds these eight feeds:

- Google News queries for global, European, Latin American, MENA, and Asian funding
- Google News queries for English-language small-business expansion and automation signals
- TechCrunch’s public feed
- EU-Startups’ public feed

Each source has a 12-hour polling interval. RSS feeds can change, disappear, omit articles, or contain syndicated duplicates. The Worker deduplicates a source item by its feed GUID or link. It creates a candidate only when its conservative headline rules recognize a funding or business-growth signal. It never sends outreach based solely on a news title.

To turn a candidate into an automatic company/signal record, configure `ENRICHMENT_API_URL` and `ENRICHMENT_API_TOKEN`. This is a one-time connector configuration, not day-to-day work. The selected service must accept the JSON request sent by `src/index.js` and return this JSON shape after checking the linked evidence:

```json
{
  "company_name": "Example Ltd",
  "official_domain": "example.com",
  "event_type": "funding",
  "event_date": "2026-09-12",
  "evidence_excerpt": "Example Ltd announced a seed round.",
  "verified": true
}
```

Candidates remain queued until the enrichment connector is configured, then each candidate without a verified official domain is held. That prevents a news headline, a guessed company identity, or an AI hallucination from entering the contact/sending pipeline. Run `POST /api/discovery/run` with the admin token to test the full discovery job immediately; otherwise cron runs it automatically.

### Funding-data provider setup

Public news cannot find every round or every small operating business. For broader coverage, connect a licensed funding-data provider. Crunchbase and Dealroom are possible providers because both publish company/funding APIs.

The Worker does **not** call Crunchbase or Dealroom directly. Their endpoints, authentication, access scope, fields, and licence terms differ. Instead, `FUNDING_PROVIDER_API_URL` must point to a small adapter you control that uses the provider's approved API access; set `FUNDING_PROVIDER_API_TOKEN` as a Worker secret. The Worker calls that adapter at most once every 12 hours with this request:

```json
{"operation":"recent_funding","since":"2026-09-07T00:00:00.000Z","max_results":100,"filters":{"employee_max":250,"excluded_company_sizes":["enterprise"]}}
```

It returns this JSON shape, containing only records allowed by that provider's licence:

```json
{
  "items": [{
    "provider_record_id": "provider-123",
    "company_name": "Example Ltd",
    "official_domain": "example.com",
    "country_code": "GB",
    "employee_band": "11-50",
    "source_url": "https://example.com/news/funding",
    "source_name": "Licensed provider",
    "evidence_excerpt": "Example Ltd announced its seed round.",
    "event_date": "2026-09-12",
    "verified": true
  }]
}
```

The Worker asks for records from the trailing seven days, filters out records that the adapter labels enterprise-sized, deduplicates each provider record, and inserts only records that the adapter marks verified. The seven-day lookback protects against a missed poll; duplicate provider IDs are ignored. Once the adapter is deployed and configured, the import runs automatically.

## API overview

All mutating `/api/*` calls require `Authorization: Bearer $ADMIN_TOKEN`. Provider callbacks use `X-Webhook-Secret`.

| Endpoint | Purpose |
|---|---|
| `POST /api/signals` | Add a company and cited discovery signal |
| `POST /api/contacts` | Add a decision-maker and verification/policy state |
| `POST /api/qualifications` | Score and decide a company |
| `POST /api/templates` | Import a versioned template |
| `POST /api/campaigns` | Create a campaign |
| `POST /api/campaigns/:id/status` | Explicitly activate, pause, or archive a campaign |
| `POST /api/enrollments` | Prepare/review a contact for a campaign |
| `POST /api/enrollments/:id/approve` | Approve a reviewed enrollment |
| `POST /api/outbox` | Render/freeze and schedule an approved message |
| `POST /api/provider-events` | Record delivery/reply/bounce/unsubscribe events |
| `POST /api/dispatch-due` | Enqueue due mail jobs (cron target) |
| `POST /api/discovery/run` | Run the automated worldwide discovery/enrichment job now (RSS + YC + funding-provider adapter) |
| `GET /api/discovery/sources` | List discovery sources and their enabled/disabled state, last run, last error |
| `POST /api/discovery/sources/:id` | `{ "enabled": true/false }` — enable or disable a source without redeploying |
| `GET /api/discovery/runs` | Recent `discovery_runs` rows (per-source counts, status, error) |
| `GET /api/companies` | List companies (`?status=`, `?limit=`, `?offset=`) |
| `GET /api/companies/:id` | Full company profile: signals, contacts, qualification, research report, lead reason, enrollments |
| `POST /api/contacts/discover/:companyId` | Free-tier-first contact discovery: website → Hunter (if configured) → Apollo (if configured) → permutation guess as a last resort |
| `POST /api/contacts/:id/verify` | Real SMTP verification via `SMTP_VERIFY_API_URL` if configured, else free DNS-over-HTTPS (MX/A) verification; advances `verification_status` |
| `POST /api/enrichment/:companyId` | Enrich a company via the paid provider if configured, else the free website-based provider |
| `POST /api/leads/:companyId/research` | Generate/refresh the research report (AI-enriched narrative if a provider is configured, deterministic fallback otherwise) + "why this lead" reasoning; fires a high-value-lead notification if the score crosses `HIGH_VALUE_LEAD_THRESHOLD` |
| `POST /api/leads/:companyId/generate-email` | Generate a personalized draft via the AI provider chain, then run claim validation against evidence; stores the draft either way, `valid=false` if any claim is unsupported |
| `GET /api/leads/:companyId/drafts` | List generated email drafts for a company |
| `GET /api/notifications` | List notifications (`?unread=true` to filter) |
| `POST /api/notifications/:id/read` | Mark a notification read |
| `GET /api/notification-preferences` | List per-event-type Slack/Discord/dashboard/email preferences |
| `PUT /api/notification-preferences` | Set which channels an event type dispatches to |
| `GET /api/activity` | Recent activity feed events |
| `GET /api/export/companies.csv` / `leads.csv` / `leads.xlsx` / `contacts.csv` / `outreach.csv` | Download current data as CSV or XLSX |
| `GET /api/analytics/overview` / `funnel` / `sources` / `campaigns` / `ai` / `providers` | Aggregate analytics (conversion funnel, AI usage/cost, per-source and per-campaign performance) |
| `GET /api/reports/daily` | Daily summary (discovered, qualified, sent, replies, bounces, by source) |
| `GET /api/dashboard` | Read current operational state |

A minimal operator dashboard that calls all of the above lives at `dashboard/index.html` — see "Dashboard" below.

## Free-tier AI provider chain (this change)

`POST /api/leads/:companyId/research` and `POST /api/leads/:companyId/generate-email` call a real, configurable AI provider chain (`src/ai.js`) instead of only the deterministic synthesizer from the previous upgrade. **Every default is chosen to run entirely within a genuinely free tier — no paid usage is assumed anywhere in this project**, and nothing about AI is a hard dependency: if no provider is configured, or every configured provider fails, both endpoints keep working (research falls back to the deterministic summary; email generation returns a clear 503 rather than a fabricated draft — see "What still requires human judgment" below).

- **Providers, and their free tiers as of this writing** (check each provider's own pricing page — free-tier terms change):
  - **Gemini** (`GEMINI_API_KEY`, free via [Google AI Studio](https://aistudio.google.com/) — no billing account required for the free tier) — `gemini-2.0-flash` is the default model.
  - **Groq** (`GROQ_API_KEY`, free at [console.groq.com](https://console.groq.com/) — generous free-tier rate limits, no credit card required) — `llama-3.3-70b-versatile` is the default model.
  - **Cloudflare Workers AI** (the `[ai]` binding in `wrangler.toml`, no separate signup or key at all — it's bundled with every Workers account's free daily allocation) — `@cf/zai-org/glm-4.7-flash` is the default model, and it's the tertiary tier specifically *because* it needs zero external setup, making it the safety net if you configure nothing else.
  Each is a plain `fetch`/binding call behind one `AIProvider`-shaped interface — nothing provider-specific leaks into `index.js`.
- **Chain order**: `AI_PRIMARY_PROVIDER` → `AI_FALLBACK_PROVIDER` → `AI_TERTIARY_PROVIDER`, each with its own model env var. A provider is only used if its required key/binding is actually present, so partially configuring the chain (e.g. Gemini only) is fine, and configuring nothing at all still leaves the deterministic/Cloudflare-Workers-AI path working.
- **Fallback logic**: `classifyAIFailure()` only falls back for transient conditions — HTTP 429, 5xx, timeouts, explicit "quota"/"rate limit" text (the exact condition a free tier hits once you exceed its request ceiling). An invalid key (401/403), malformed request (400), or policy rejection (422) is fatal and moves straight to the next provider without retrying the same one, so a real bug doesn't get silently masked by three providers all failing the same way.
- **Retries**: up to `AI_MAX_RETRIES` retries per provider with exponential backoff + jitter (`computeBackoffMs()`) before moving to the next provider — this matters more on a free tier, where a burst of requests is exactly what trips a rate limit.
- **Token budget enforcement**: every prompt is truncated to `AI_MAX_INPUT_TOKENS` (`truncateToTokenBudget()`, a ~4-chars-per-token heuristic) before being sent, so a single research/personalization call can't accidentally blow through a free tier's per-request or per-minute token ceiling.
- **Usage tracking, not cost tracking**: every attempt — success or failure — is written to the `ai_usage` table (provider, model, operation, tokens, status, error code). `estimated_cost` is hard-coded to `0` for all three providers (`APPROX_COST_PER_1K_TOKENS` in `src/ai.js`) since the intent is to never leave the free tier; `GET /api/analytics/ai` surfaces call counts and failure/fallback rates instead, which is what actually tells you when you're approaching a free-tier limit.
- **Token efficiency**: prompts are built by `buildResearchPrompt()`/`buildPersonalizationPrompt()`/`buildClaimValidationPrompt()` in `src/core.js` from structured facts already in the database, not raw scraped pages, keeping each call in the few-hundred-to-low-thousands-token range this project targets for a 100–300 email/month workload — comfortably inside any of the three free tiers above at that volume.
- **Claim validation gate**: `POST /api/leads/:companyId/generate-email` always runs a second AI call that checks every factual claim in the drafted body against the evidence used for research, and stores the draft with `valid = false` if anything comes back `UNSUPPORTED` or `UNCERTAIN` (`evaluateClaimValidation()` treats "uncertain" as blocking, not passing). This never blocks the API from returning the draft — it blocks a human from mistaking an unsupported draft for a send-ready one.
- **Prompt-injection boundary**: unchanged from the previous upgrade's `sanitizeUntrustedText()` — see "Prompt-injection posture" above. `buildResearchPrompt()` puts every externally sourced excerpt inside an `<untrusted_external_data>` block and the system prompt explicitly tells the model that block is data, never instructions.

### What still requires human judgment

`AUTO_SEND_ENABLED` defaults to `false` and nothing in this codebase reads it to auto-schedule anything — there is no code path from AI generation straight into the outbox. A generated draft lands in the `email_drafts` table for a human to read via `GET /api/leads/:companyId/drafts` (or the dashboard); turning it into an actual send still goes through the existing, unchanged `POST /api/enrollments` → `POST /api/enrollments/:id/approve` → outbox pipeline, which still requires a `valid` contact and an eligible policy decision regardless of what the AI claim-validator said.

## Free-tier-first enrichment, contact discovery, and email verification (this change)

`src/enrichment.js` now layers several genuinely free (or free-tier, budget-capped) providers, several of them adapted from the person's own [Reacher/startup-tracker](https://github.com/Rancidgift57/Reacher) project — a Python/FastAPI pipeline that does the same job with `dnspython` + SMTP RCPT-TO checks, Hunter/Apollo clients, and a Clearbit/DuckDuckGo domain resolver. Every step below tries the free, no-key option first and only escalates to a budget-capped free-tier API if one is configured:

- **`resolveDomainFromCompanyName()`** *(new)* — ported from `domain_resolver.py`: Clearbit's old autocomplete endpoint (kept as a first attempt, but it's reported as sunset since Clearbit folded into HubSpot, so it fails soft) then a DuckDuckGo HTML-results search, both free with no signup, filtered against a blocklist of aggregator/news/social domains (`isBlockedResolutionDomain()`) and scored by name similarity (`domainNameSimilarity()`), with the result only accepted once it has a real DNS MX or A record. **This closes a real gap from the previous upgrade**: without a paid `ENRICHMENT_API_URL`, an RSS-discovered funding headline used to sit `held` forever because nothing could turn a bare company name into a domain; `POST /api/discovery/run` now reports `"enrichment": "free_domain_resolution"` and actually creates companies from RSS sources with zero paid keys configured (verified end-to-end in `test/free_tier_smoke.integration.test.js`).
- **`enrichCompanyFromWebsite()`** — unchanged from the previous upgrade: fetches the company's own homepage and extracts only what it explicitly states. `POST /api/enrichment/:companyId` uses the paid `ENRICHMENT_API_URL` path if configured, and this free path otherwise.
- **Contact discovery now tries, in order** (`discoverContactsFreeTierFirst()`): (1) the company's own website (`mailto:` links, always free), (2) **Hunter.io's free plan** if `HUNTER_API_KEY` is set, self-throttled against `HUNTER_MONTHLY_BUDGET` via a persistent, D1-backed budget (`spendBudget()`, reusing the existing `usage_ledger` table rather than adding a new one — a direct port of `rate_limit.py`'s `CreditBudget`), (3) **Apollo.io's free people-search** if `APOLLO_API_KEY` is set (names only; Apollo's email-revealing `match_person` call spends a credit per use and is deliberately not wired up by default), and only as a last resort (4) **email permutation** (`generateEmailCandidates()`, a direct port of `email_permutator.py`'s pattern list) against a named person Apollo found but didn't have an email for. A permutation guess is stored with `contact_basis = "permutation_guess"` and can never reach `verification_status = "valid"` on its own — it needs an actual check first (see below). The end-to-end budget enforcement (a 3rd Hunter call actually getting refused once the monthly budget is spent) is verified in the test suite, not just implemented.
- **`verifyEmailViaDns()`** — unchanged: Cloudflare's public DNS-over-HTTPS resolver, checking for a real MX (or A) record. Free, no key, genuine domain-level signal, but it can't confirm an individual mailbox exists.
- **`verifyEmailViaExternalSmtpService()`** *(new)* — a real `EmailVerificationProvider` adapter for actual SMTP-level (RCPT-TO) verification, for when you want more confidence than DNS alone gives you. **Cloudflare Workers cannot do this themselves**: the Workers runtime blocks outbound TCP connections on port 25 by default ([Cloudflare's own docs](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), "Considerations" — confirmed before building this, not assumed), so a real RCPT-TO handshake has to run somewhere with normal outbound network access. `SMTP_VERIFY_API_URL` points the Worker at any HTTP service that accepts `{"email": "..."}` and returns `{"status": "valid|invalid|catch_all|unknown", "detail": "..."}` — and **this delivery includes exactly that service**: a new `POST /api/verify-email` endpoint added to `startup-tracker/main.py` in your Reacher repo (see the patch below), which wraps your existing `SMTPVerifier` class with no new verification logic of its own. `POST /api/contacts/:id/verify` tries this first if configured, falling back to the free DNS-only check otherwise.

### Honest caveats on the free-tier providers

- **Clearbit's autocomplete endpoint may simply not respond** — it's a legacy, undocumented endpoint kept only as a first attempt; DuckDuckGo is the real fallback and does most of the actual work.
- **Scraping DuckDuckGo's HTML results page is fragile by nature** (no API contract, selector-dependent) and can break if DuckDuckGo changes its markup, or get rate-limited under sustained load — acceptable for this project's discovery volume, not something to lean on hard.
- **Permutation-guessed contacts are guesses.** `generateEmailCandidates()` never marks its own output as verified; if you don't configure `SMTP_VERIFY_API_URL`, the only check available for a guess is the DNS-only path, which confirms the *domain* accepts mail, not that *that specific address* exists.
- **Hunter/Apollo "free" still means signing up for an account and getting a key** — unlike Cloudflare Workers AI or the DNS/website-scraping paths, they're not zero-setup. They're included because your own Reacher project already uses them this way and budget-guards them correctly; they stay off by default (no key = never called).

## Reacher/startup-tracker companion patch (this change)

Delivered alongside this repo is a small patch to your `Rancidgift57/Reacher` repo's `startup-tracker/main.py`: it adds `POST /api/verify-email`, which wraps your existing `SMTPVerifier` (from `enrichment/smtp_verifier.py`) with no new verification logic — it just exposes it over HTTP so the Worker's `SMTP_VERIFY_API_URL` adapter has something real to call. One `SMTPVerifier` instance is created at module load and reused across requests, so its internal MX/catch-all caches actually help under repeated calls, same as the rest of your pipeline already relies on.

```sh
curl -X POST https://your-startup-tracker.example.com/api/verify-email \
  -H "content-type: application/json" -H "x-api-key: $YOUR_API_KEY" \
  -d '{"email":"founder@example.ai"}'
# {"email":"founder@example.ai","status":"valid","detail":"250 2.1.5 OK"}
```

It reuses your existing `settings.api_key` check (same `X-API-Key` header your `/api/pipeline/run` endpoint already expects), so no new auth mechanism was introduced. Point the Worker's `SMTP_VERIFY_API_URL` at wherever you deploy this endpoint and `SMTP_VERIFY_API_KEY` at the same key, and `POST /api/contacts/:id/verify` will use it automatically.

Deploying this FastAPI service itself (a normal host, not Cloudflare Workers) is outside the scope of what could be tested here — the patch was verified with Python's own `py_compile` against your actual `main.py`, `config.py`, and `enrichment/smtp_verifier.py`, but not run end-to-end against a live database/Redis, since that infrastructure isn't part of this delivery.

## Real Slack/Discord notifications (this change)

`src/notification_channels.js` sends actual webhook requests. The dashboard feed (the `notifications` table) is always populated, as before; external channels are opt-in per event type via the new `notification_preferences` table:

```sh
curl -X PUT $BASE/api/notification-preferences \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"event_type":"NEW_HIGH_VALUE_LEAD","dashboard":true,"slack":true}'
```

Slack (`SLACK_ENABLED=true` + `SLACK_WEBHOOK_URL`) and Discord (`DISCORD_ENABLED=true` + `DISCORD_WEBHOOK_URL`) are checked independently of the preference — both the global switch and the per-event-type opt-in must be on. A failed webhook is logged and swallowed; it can never break the discovery/research/notification pipeline that triggered it. An "internal notification email" channel (spec: distinct from outreach email, its own recipient, never sharing a send queue with outreach) is a documented extension point in that file, not implemented, since it would need its own recipient configuration this repo doesn't yet have a place for.

## CSV / XLSX export and analytics (this change)

`GET /api/export/{companies,leads,contacts,outreach}.csv` and `GET /api/export/leads.xlsx` generate synchronously. At the 100–300 emails/month scale this system targets, synchronous generation is simpler and just as fast as a queue+job+storage system would be, so — per the "do not introduce unnecessary infrastructure" principle — there's no export queue or job table; if your dataset grows enough that this becomes slow, that's the point to add one.

The XLSX writer (`src/xlsx.js`) is a small, dependency-free implementation, not a wrapper around a library: Workers have no filesystem and pulling in a full zip/xlsx package for a few-hundred-row export felt like more than this needed, so it hand-builds a valid, uncompressed (STORE-mode) ZIP containing the handful of OOXML parts a single-sheet workbook needs. It's genuinely valid — the test suite round-trips it through Python's `zipfile` and `openpyxl`, not just checking magic bytes.

`GET /api/analytics/{overview,funnel,sources,campaigns,ai,providers}` are plain SQL aggregations over existing tables (plus the new `ai_usage` table for the `ai` endpoint) — no new data model beyond what discovery/research/outreach already produce.

## Dashboard (this change, scoped down from the original ask)

The spec asked for a full TypeScript/React/Tailwind dashboard. This repository is a bare Cloudflare Worker with no bundler, and standing up a React build pipeline felt like a larger, separate piece of infrastructure than this change should silently introduce. Instead, `dashboard/index.html` is a single, self-contained, dependency-free HTML/JS file: it talks directly to your deployed Worker's API (you enter the Worker URL and an admin token once; both are kept in that page's own `localStorage`, nothing is sent anywhere else) and covers Dashboard, Companies (with a full company detail drawer — research, evidence, contacts, drafts, and one-click enrich/verify/research/generate-email actions), Discovery, Notifications, Activity, Analytics, and Exports.

Host it anywhere that can serve a static file (GitHub Pages, Cloudflare Pages, S3, or just open it locally) — it does not need to be deployed alongside the Worker. It has not been exercised in an actual browser as part of this change (only its embedded JS has been syntax-checked); treat it as a functional first pass, and if you want the full React/Tailwind version the spec described, that's a legitimate next step this file doesn't replace.

## Known limitations and roadmap

This upgrade (across all three change sets) covers: pluggable discovery (RSS + YC) with dedup and free domain resolution; free-tier-first contact discovery (website → Hunter → Apollo → permutation guess) and email verification (DNS, or real SMTP via your own Reacher deployment); a free-tier AI provider chain with fallback, retries, usage tracking, and a claim-validation gate; real Slack/Discord notifications; CSV/XLSX export; funnel/source/campaign/AI analytics; and a functional (if minimal) dashboard — all with a human still required to approve before anything sends. It intentionally does **not** include, and would need further work before being called complete against the full spec:

- **LinkedIn.** Deliberately not implemented as a scraper, per the requirement to never bypass authentication, CAPTCHAs, or rate limits. `discovery_sources.provider_type` leaves room for a `linkedin` row once an authorized API/partnership is in place.
- **Paid, non-free-tier enrichment/contact/email-verification providers.** `ENRICHMENT_API_URL`/`CONTACT_PROVIDER_API_URL` remain adapter points for a paid vendor if you ever want one; this change deliberately ships only free/free-tier implementations behind them.
- **Deploying the Reacher/startup-tracker `/api/verify-email` service itself.** The Worker-side adapter and the FastAPI patch are both real and tested independently (Worker: mocked-HTTP integration test; FastAPI: `py_compile` against your actual files); the two have not been exercised against each other over a live network, since standing up your Postgres/Redis/Celery stack is outside this delivery.
- **Internal notification email**, as distinct from outreach email (spec §24) — the webhook-based Slack/Discord channels are real; email notifications are a documented extension point, not implemented.
- **A production React/Tailwind dashboard** — `dashboard/index.html` is a real, working, but intentionally minimal stand-in; see "Dashboard" above.
- **An async export job/queue** for XLSX/CSV — intentionally skipped as unneeded infrastructure at the target scale; see "CSV / XLSX export and analytics" above.
- **Free-tier terms drift.** Every specific number in this README (Hunter's ~25-50 searches/month, Gemini's/Groq's rate limits, Clearbit's autocomplete even still existing) is what was true at writing time, sourced from each provider's own pages where checked — verify current terms before depending on them, especially since this project deliberately treats "free" as a hard requirement, not a rough target.

See [OUTREACH_SYSTEM_PLAN.md](./OUTREACH_SYSTEM_PLAN.md) for the commercial rules, sourcing method, policy requirements, cost controls, and acceptance checks.