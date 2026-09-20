import {
  REQUIRED_PERSONALIZATION_FIELDS, canDispatch, eventAction, id, nowIso,
  extractFundingCandidate, qualificationDecision, renderTemplate, safeUrl,
  normalizeDomain, mapYcCompany, nextVerificationState, scoreStartupSignals,
  buildLeadReason, buildNotification, extractMailtoContacts, sanitizeUntrustedText,
  buildResearchPrompt, buildPersonalizationPrompt, buildClaimValidationPrompt,
  parseAIJson, evaluateClaimValidation, toCsv, resolveNotificationChannels
} from "./core.js";
import { callAIWithFallback } from "./ai.js";
import { enrichCompanyFromWebsite, verifyEmailViaDns, verifyEmailViaExternalSmtpService, resolveDomainFromCompanyName, discoverContactsFreeTierFirst } from "./enrichment.js";
import { dispatchNotification } from "./notification_channels.js";
import { buildXlsxWorkbook } from "./xlsx.js";

const DEFAULT_DISCOVERY_SOURCES = [
  ["global-funding-en", "Global funding news", "global", "en", "https://news.google.com/rss/search?q=%28startup+OR+company%29+%28raised+OR+raises+OR+funding%29+%28seed+OR+%22series+A%22+OR+%22series+B%22%29&hl=en-US&gl=US&ceid=US:en"],
  ["europe-funding-en", "Europe funding news", "Europe", "en", "https://news.google.com/rss/search?q=%28startup+OR+company%29+%28raised+OR+raises+OR+funding%29+Europe&hl=en-GB&gl=GB&ceid=GB:en"],
  ["latam-funding-es", "Latin America funding news", "Latin America", "es", "https://news.google.com/rss/search?q=%28startup+OR+empresa%29+%28ronda+OR+financiaci%C3%B3n+OR+inversi%C3%B3n%29&hl=es-419&gl=MX&ceid=MX:es-419"],
  ["mena-funding-en", "MENA funding news", "MENA", "en", "https://news.google.com/rss/search?q=%28startup+OR+company%29+%28raised+OR+funding%29+%28MENA+OR+Middle+East+OR+Africa%29&hl=en&gl=AE&ceid=AE:en"],
  ["asia-funding-en", "Asia funding news", "Asia", "en", "https://news.google.com/rss/search?q=%28startup+OR+company%29+%28raised+OR+funding%29+Asia&hl=en&gl=SG&ceid=SG:en"],
  ["small-business-growth-en", "Small business growth news", "global", "en", "https://news.google.com/rss/search?q=%28small+business+OR+SME%29+%28expands+OR+expansion+OR+warehouse+OR+automation%29&hl=en-US&gl=US&ceid=US:en"],
  ["techcrunch", "TechCrunch", "global", "en", "https://techcrunch.com/feed/"],
  ["eu-startups", "EU-Startups", "Europe", "en", "https://www.eu-startups.com/feed/"]
];

/**
 * Public, unofficial mirror of Y Combinator's own Algolia-backed company directory
 * (see https://github.com/use-list/API--Y-Combinator-API). It is refreshed by that
 * project's own GitHub Actions job, not scraped by this Worker, and needs no auth.
 * Operators should confirm this source still meets their own compliance bar before
 * relying on it in production; the URL is a normal, disable-able discovery_sources row.
 */
const YC_DIRECTORY_SOURCE = ["ycombinator-directory", "Y Combinator company directory", "global", "en", "https://yc-oss.github.io/api/companies/all.json", "json_feed"];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const error = (message, status = 400) => json({ error: message }, status);

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("Content-Type must be application/json");
  return request.json();
}

function requireAdmin(request, env) {
  const supplied = request.headers.get("authorization");
  if (!env.ADMIN_TOKEN || supplied !== `Bearer ${env.ADMIN_TOKEN}`) throw new Response("Unauthorized", { status: 401 });
}

function requireWebhook(request, env) {
  if (!env.WEBHOOK_SECRET || request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET) throw new Response("Unauthorized", { status: 401 });
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function one(db, sql, ...params) { return db.prepare(sql).bind(...params).first(); }
async function all(db, sql, ...params) { return (await db.prepare(sql).bind(...params).all()).results || []; }
async function run(db, sql, ...params) { return db.prepare(sql).bind(...params).run(); }

async function companyById(env, idValue) { return one(env.DB, "SELECT * FROM companies WHERE id = ?", idValue); }
async function contactById(env, idValue) { return one(env.DB, "SELECT * FROM contacts WHERE id = ?", idValue); }

async function upsertCompany(env, data, timestamp) {
  const name = requiredString(data.company_name, "company_name");
  const domain = requiredString(data.company_domain, "company_domain").toLowerCase().replace(/^www\./, "");
  const current = await one(env.DB, "SELECT * FROM companies WHERE domain = ?", domain);
  if (current) return current;
  const company = {
    id: id("co"), name, domain, country: data.country_code?.toUpperCase() || null,
    timezone: data.timezone || null, employeeBand: data.employee_band || null
  };
  await run(env.DB, `INSERT INTO companies (id,name,domain,country_code,timezone,employee_band,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, company.id, company.name, company.domain, company.country, company.timezone, company.employeeBand, timestamp, timestamp);
  return companyById(env, company.id);
}

function stripCdata(value = "") { return value.replace(/^<!\[CDATA\[/, "").replace(/]]>$/, ""); }
function decodeXml(value = "") { return stripCdata(value).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }
function xmlTag(block, tag) { const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i")); return match ? decodeXml(match[1]) : ""; }
function parseRss(xml) {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 30).map((match) => {
    const block = match[1]; const link = xmlTag(block, "link"); const guid = xmlTag(block, "guid") || link;
    return { key: guid, url: link, title: xmlTag(block, "title"), summary: xmlTag(block, "description"), published_at: xmlTag(block, "pubDate") };
  }).filter((item) => item.key && item.url && item.title);
}

async function bootstrapSources(env) {
  const timestamp = nowIso();
  for (const [stableId, name, region, language, url] of DEFAULT_DISCOVERY_SOURCES) {
    await run(env.DB, "INSERT OR IGNORE INTO discovery_sources (id,name,provider_type,source_type,url,region,language,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", stableId, name, "rss_headline", "rss", url, region, language, timestamp, timestamp);
  }
  if ((env.YC_ENABLED ?? "true") === "true") {
    const [stableId, name, region, language, url, sourceType] = YC_DIRECTORY_SOURCE;
    await run(env.DB, "INSERT OR IGNORE INTO discovery_sources (id,name,provider_type,source_type,url,region,language,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", stableId, name, "yc_directory", sourceType, url, region, language, timestamp, timestamp);
  }
}

/** Starts a row in discovery_runs so every discovery execution is observable (spec §29). */
async function startRun(env, provider, sourceId = null) {
  const runId = id("run"); const timestamp = nowIso();
  await run(env.DB, "INSERT INTO discovery_runs (id,source_id,provider,started_at,status,created_at) VALUES (?,?,?,?,?,?)", runId, sourceId, provider, timestamp, "running", timestamp);
  return runId;
}
async function finishRun(env, runId, outcome) {
  await run(env.DB, "UPDATE discovery_runs SET status=?,completed_at=?,items_found=?,items_new=?,items_duplicate=?,items_failed=?,error=? WHERE id=?",
    outcome.error ? "failed" : "completed", nowIso(), outcome.found || 0, outcome.new || 0, outcome.duplicate || 0, outcome.failed || 0, outcome.error || null, runId);
}

async function recordActivity(env, type, summary, companyId = null, payload = {}) {
  await run(env.DB, "INSERT INTO activity_events (id,type,summary,company_id,payload_json,created_at) VALUES (?,?,?,?,?,?)", id("act"), type, summary, companyId, JSON.stringify(payload), nowIso());
}

async function insertNotification(env, args) {
  const notification = buildNotification(args);
  const notificationId = id("note");
  await run(env.DB, "INSERT INTO notifications (id,type,title,message,company_id,enrollment_id,outbox_id,severity,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    notificationId, notification.type, notification.title, notification.message, args.companyId || null, args.enrollmentId || null, args.outboxId || null, notification.severity, nowIso());
  const record = { id: notificationId, ...notification };
  try { await dispatchNotification(env, record); } catch (cause) { console.error("notification dispatch failed", cause.message); }
  return record;
}

/**
 * Fetches and normalizes the YC company directory (see YC_DIRECTORY_SOURCE above).
 * Unlike RSS headlines, this source publishes the company's own website directly, so
 * (per spec §5) it is treated as sufficient evidence of company identity on its own --
 * no separate ENRICHMENT_API round-trip is required to trust the domain. It never
 * invents anything YC did not publish; mapYcCompany leaves unknown fields null.
 */
async function runYcDiscovery(env, source) {
  const runId = await startRun(env, "ycombinator", source.id);
  const timestamp = nowIso();
  let found = 0, created = 0, duplicate = 0, failed = 0;
  try {
    const response = await fetch(source.url, { headers: { "user-agent": "ArgmaxOutreachResearch/0.1 (+https://argmax.one)" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 20_000_000) throw new Error("YC directory response exceeds 20 MB");
    const payload = JSON.parse(body);
    if (!Array.isArray(payload)) throw new Error("Unexpected YC directory shape");
    for (const raw of payload) {
      const mapped = mapYcCompany(raw);
      if (!mapped) { failed += 1; continue; }
      found += 1;
      try {
        const existing = await one(env.DB, "SELECT id FROM companies WHERE domain=?", mapped.domain);
        const company = await upsertCompany(env, { company_name: mapped.company_name, company_domain: mapped.domain }, timestamp);
        if (existing) { duplicate += 1; continue; }
        created += 1;
        const evidenceExcerpt = `YC batch ${mapped.batch || "UNKNOWN"}. Category: ${mapped.category || "UNKNOWN"}. Hiring: ${mapped.is_hiring ? "yes" : "no"}. Team size: ${mapped.team_size ?? "UNKNOWN"}. ${mapped.description || ""}`.slice(0, 2000);
        await run(env.DB, `INSERT OR IGNORE INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,event_date,published_at,retrieved_at,evidence_excerpt,confidence,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("sig"), company.id, safeUrl(mapped.source_url), "ycombinator", mapped.key, `${mapped.company_name} — YC ${mapped.batch || ""}`.trim(), mapped.description || "", "yc_startup_directory", null, null, timestamp, evidenceExcerpt, "corroborated", timestamp);
        await run(env.DB, `INSERT OR IGNORE INTO discovery_candidates (id,source_id,source_item_key,source_url,title,summary,retrieved_at,extracted_company_name,extracted_domain,extracted_event_type,extraction_confidence,status,company_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("cand"), source.id, mapped.key, mapped.source_url, mapped.company_name, mapped.description || "", timestamp, mapped.company_name, mapped.domain, "yc_startup_directory", 90, "enriched", company.id, timestamp, timestamp);
        await recordActivity(env, "COMPANY_DISCOVERED", `New startup discovered: ${mapped.company_name} (YC ${mapped.batch || "n/a"})`, company.id, { source: "ycombinator", batch: mapped.batch });
        await discoverContactsFromWebsite(env, company).catch(() => {});
      } catch (cause) { failed += 1; console.error("yc record skipped", cause.message); }
    }
    await run(env.DB, "UPDATE discovery_sources SET last_run_at=?,last_error=NULL,updated_at=? WHERE id=?", timestamp, timestamp, source.id);
    await finishRun(env, runId, { found, new: created, duplicate, failed });
    return { found, created, duplicate, failed };
  } catch (cause) {
    await run(env.DB, "UPDATE discovery_sources SET last_error=?,updated_at=? WHERE id=?", String(cause.message).slice(0, 500), timestamp, source.id);
    await finishRun(env, runId, { error: String(cause.message).slice(0, 500) });
    await insertNotification(env, { type: "DISCOVERY_ERROR", companyName: "", extra: { provider: "ycombinator", message: cause.message } });
    return { error: cause.message };
  }
}

/**
 * Best-effort ContactDiscoveryProvider over a company's own public website (spec §11).
 * It only records addresses the site itself published as mailto: links -- it never
 * guesses a pattern like first.last@domain -- and every contact starts at
 * verification_status "pending", never "valid", so nothing here can reach the send
 * pipeline without a real verification step (spec §12/§13's canDispatch gate already
 * requires verification_status = "valid").
 */
/**
 * Contact discovery, now free-tier-first across every source this project
 * supports (spec: website always tried first and always free; Hunter/Apollo
 * used only if their keys are configured, and only within their persisted
 * monthly budget; permutation guessing as a last resort, and it is never
 * more than "pending" -- see discoverContactsFreeTierFirst's docstring).
 */
async function discoverContactsFromWebsite(env, company) {
  const existingCount = (await one(env.DB, "SELECT COUNT(*) AS count FROM contacts WHERE company_id=?", company.id)).count;
  if (existingCount > 0) return { found: 0, skipped: "already_has_contacts" };
  const { contacts, source } = await discoverContactsFreeTierFirst(env, company);
  if (!contacts.length) return { found: 0, skipped: "no_contacts_found" };
  const timestamp = nowIso();
  let created = 0;
  for (const contact of contacts) {
    const prior = await one(env.DB, "SELECT id FROM contacts WHERE email=?", contact.email);
    if (prior) continue;
    await run(env.DB, `INSERT INTO contacts (id,company_id,email,first_name,last_name,title,role_evidence_url,email_source,verification_status,contact_basis,policy_status,discovery_source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("ct"), company.id, contact.email, contact.firstName || null, contact.lastName || null, contact.title || null,
      safeUrl(`https://${company.domain}`), contact.source, "pending", contact.source, "hold", contact.source, timestamp, timestamp);
    created += 1;
  }
  if (created) await recordActivity(env, "CONTACT_FOUND", `Found ${created} contact(s) for ${company.name} via ${source}${source === "permutation_guess" ? " (unverified guess -- needs a real check before use)" : ""}`, company.id, { source });
  return { found: created };
}

/**
 * Deterministic AI-research-agent stand-in (spec §13). It only ever emits facts that
 * are already structured, stored, evidenced rows in this database (signals, contacts) --
 * it never calls an unconfigured external model and never invents funding, headcount,
 * technologies, or business problems. Any free text pulled from an external source
 * (a signal's summary) is passed through sanitizeUntrustedText first: if it looks like
 * it is trying to issue instructions, it is dropped rather than quoted. This keeps the
 * "TRUSTED INSTRUCTIONS -> UNTRUSTED WEB CONTENT -> EXTRACT FACTS ONLY" boundary from
 * spec §40 even before a real AI_PROVIDER is wired in; a future call to AI_PROVIDER
 * should follow the exact same rule -- only ever pass sanitizeUntrustedText().wrapped
 * text to the model, in a role clearly separate from system instructions, and only
 * accept back fields that also match something already in this database.
 */
async function runResearch(env, companyId) {
  const company = await companyById(env, companyId);
  if (!company) return null;
  const signals = await all(env.DB, "SELECT * FROM signals WHERE company_id=? ORDER BY retrieved_at DESC", companyId);
  const contacts = await all(env.DB, "SELECT * FROM contacts WHERE company_id=?", companyId);
  const fundingSignal = signals.find((s) => s.event_type === "funding");
  const ycSignal = signals.find((s) => s.event_type === "yc_startup_directory");
  const isHiring = signals.some((s) => /hiring:\s*yes/i.test(s.evidence_excerpt || "") || s.event_type === "business_growth");
  const isAiProduct = signals.some((s) => /\bAI\b|artificial intelligence|generative ai|machine learning/i.test(`${s.title} ${s.summary} ${s.evidence_excerpt}`));
  const verifiedDecisionMaker = contacts.find((c) => c.verification_status === "valid" && /founder|ceo|cto|co-founder|chief/i.test(c.title || ""));
  const fundingDays = fundingSignal ? Math.round((Date.now() - Date.parse(fundingSignal.event_date || fundingSignal.published_at || fundingSignal.retrieved_at)) / 86_400_000) : null;
  const argmaxFit = isAiProduct ? "high" : isHiring ? "medium" : "low";
  const scoring = scoreStartupSignals({
    hasFundingSignal: !!fundingSignal, fundingWithinDays: fundingDays, isHiringEngineers: isHiring,
    isAiProduct, argmaxFit, hasVerifiedDecisionMaker: !!verifiedDecisionMaker
  });
  const argmaxNeeds = [];
  if (isAiProduct) argmaxNeeds.push({ service: "AI Engineering", priority: "HIGH" });
  if (isHiring || fundingSignal) argmaxNeeds.push({ service: "Backend Engineering", priority: isAiProduct ? "HIGH" : "MEDIUM" });
  if (ycSignal) argmaxNeeds.push({ service: "MVP/Product Development", priority: "MEDIUM" });
  const reason = buildLeadReason({
    company, score: scoring.total, argmaxNeeds,
    signals: { hasFundingSignal: !!fundingSignal, fundingWithinDays: fundingDays, isHiringEngineers: isHiring, isAiProduct, isEarlyStage: !!ycSignal }
  });
  const evidence = [];
  for (const s of [fundingSignal, ycSignal].filter(Boolean)) {
    const sanitized = sanitizeUntrustedText(s.evidence_excerpt);
    if (sanitized.flagged) continue; // dropped, not quoted -- see docstring above
    evidence.push({ source_url: s.source_url, retrieved_at: s.retrieved_at, excerpt: sanitized.text.slice(0, 500) });
  }
  const timestamp = nowIso();
  const deterministicSummary = company.name + (ycSignal ? " is a Y Combinator company." : "") + (fundingSignal ? " It has a recorded funding signal." : "") + (!ycSignal && !fundingSignal ? " No structured signals are on file yet; treat company context as UNKNOWN beyond its name and domain." : "");

  // Optional real-AI enrichment of the narrative fields. The deterministic score/
  // reason above is the source of truth either way (spec: "prefer deterministic
  // business logic wherever possible" / "the AI must NOT invent" facts) -- this
  // only asks the model to summarize what's already been supplied as verified
  // facts and sanitized evidence, never to add new facts of its own.
  let aiResearch = null; let aiMeta = null;
  const { system, user } = buildResearchPrompt({ company, signals, evidence });
  const aiResult = await callAIWithFallback(env, { operation: "research", systemPrompt: system, userPrompt: user, maxOutputTokens: Number(env.AI_MAX_OUTPUT_TOKENS ?? 800) });
  if (aiResult) {
    const parsed = parseAIJson(aiResult.text);
    if (parsed && typeof parsed.summary === "string") { aiResearch = parsed; aiMeta = { provider: aiResult.provider, model: aiResult.model }; }
  }
  const summary = aiResearch?.summary || deterministicSummary;

  await run(env.DB, `INSERT INTO research_reports (company_id,company_summary,recent_signals_json,potential_needs_json,argmax_services_json,reason_for_contact,evidence_json,ai_research_json,ai_model,ai_provider,generated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET company_summary=excluded.company_summary,recent_signals_json=excluded.recent_signals_json,potential_needs_json=excluded.potential_needs_json,argmax_services_json=excluded.argmax_services_json,reason_for_contact=excluded.reason_for_contact,evidence_json=excluded.evidence_json,ai_research_json=excluded.ai_research_json,ai_model=excluded.ai_model,ai_provider=excluded.ai_provider,generated_at=excluded.generated_at`,
    companyId, summary, JSON.stringify(signals.map((s) => ({ event_type: s.event_type, retrieved_at: s.retrieved_at }))), JSON.stringify(argmaxNeeds.map((n) => n.service)), JSON.stringify(argmaxNeeds), reason.reason_for_contact, JSON.stringify(evidence), JSON.stringify(aiResearch || {}), aiMeta?.model || null, aiMeta?.provider || "deterministic_evidence_synthesizer", timestamp);
  await run(env.DB, `INSERT INTO lead_reasons (company_id,why_json,argmax_needs_json,reason_for_contact,signal_score,signal_score_breakdown_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET why_json=excluded.why_json,argmax_needs_json=excluded.argmax_needs_json,reason_for_contact=excluded.reason_for_contact,signal_score=excluded.signal_score,signal_score_breakdown_json=excluded.signal_score_breakdown_json,updated_at=excluded.updated_at`,
    companyId, JSON.stringify(reason.why), JSON.stringify(argmaxNeeds), reason.reason_for_contact, scoring.total, JSON.stringify(scoring.breakdown), timestamp, timestamp);
  await recordActivity(env, "LEAD_QUALIFIED", `Research generated for ${company.name} (signal score ${scoring.total})`, companyId, { score: scoring.total });
  const threshold = Number(env.HIGH_VALUE_LEAD_THRESHOLD || 70);
  let notification = null;
  if (scoring.total >= threshold) {
    notification = await insertNotification(env, { type: "NEW_HIGH_VALUE_LEAD", companyId, companyName: company.name, score: scoring.total, threshold });
  }
  return { company, reason, score: scoring, evidence, notification, ai_research: aiResearch, ai_meta: aiMeta };
}

async function addCandidate(env, source, item) {
  const timestamp = nowIso();
  let sourceUrl;
  try { sourceUrl = safeUrl(item.url); } catch { return false; }
  const extraction = extractFundingCandidate(item.title, item.summary);
  const candidateId = id("cand");
  const insert = await run(env.DB, `INSERT OR IGNORE INTO discovery_candidates (id,source_id,source_item_key,source_url,title,summary,published_at,retrieved_at,extracted_company_name,extracted_event_type,extraction_confidence,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, candidateId, source.id, item.key.slice(0, 1000), sourceUrl, item.title.slice(0, 1000), item.summary.slice(0, 5000), item.published_at || null, timestamp, extraction.company_name, extraction.event_type, extraction.confidence, extraction.confidence ? "new" : "held", timestamp, timestamp);
  return !!insert.meta?.changes;
}

/**
 * Calls an optional user-selected paid enrichment service if configured; if
 * not, falls back to the free, no-key domain resolver (resolveDomainFromCompanyName
 * in src/enrichment.js -- Clearbit's autocomplete + DuckDuckGo HTML search,
 * both free with no signup). This is the fix for a real gap: without a paid
 * ENRICHMENT_API_URL, an RSS-discovered funding headline used to sit "held"
 * forever, so discovery from RSS sources produced nothing usable unless you
 * paid for an enrichment API. The free path is weaker (no verified company
 * facts beyond "this headline named this company and this domain resolves"),
 * so it only proceeds when addCandidate's own conservative extraction already
 * found a plausible company name and event type in the headline text itself --
 * the evidence_excerpt is that public headline/summary verbatim, never invented.
 */
async function enrichCandidate(env, candidate) {
  if (env.ENRICHMENT_API_URL && env.ENRICHMENT_API_TOKEN) {
    const response = await fetch(env.ENRICHMENT_API_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.ENRICHMENT_API_TOKEN}` }, body: JSON.stringify({ candidate: { id: candidate.id, title: candidate.title, summary: candidate.summary, source_url: candidate.source_url, extracted_company_name: candidate.extracted_company_name, extracted_event_type: candidate.extracted_event_type }, required_output: { company_name: "string", official_domain: "string", event_type: "string", event_date: "ISO date or null", evidence_excerpt: "string", verified: "boolean" } }) });
    if (!response.ok) return { status: "held", reason: `enrichment_http_${response.status}` };
    const result = await response.json();
    if (!result?.verified || typeof result.company_name !== "string" || typeof result.official_domain !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(result.official_domain) || typeof result.evidence_excerpt !== "string") return { status: "held", reason: "enrichment_not_verified" };
    const timestamp = nowIso();
    const company = await upsertCompany(env, { company_name: result.company_name, company_domain: result.official_domain }, timestamp);
    const sourceKey = `candidate:${candidate.id}`;
    await run(env.DB, `INSERT OR IGNORE INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,event_date,published_at,retrieved_at,evidence_excerpt,confidence,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("sig"), company.id, candidate.source_url, "automated discovery", sourceKey, candidate.title, candidate.summary, result.event_type || candidate.extracted_event_type || "business_signal", result.event_date || null, candidate.published_at || null, timestamp, result.evidence_excerpt, "corroborated", timestamp);
    await run(env.DB, "UPDATE discovery_candidates SET status='enriched',extracted_company_name=?,extracted_domain=?,company_id=?,updated_at=? WHERE id=?", result.company_name, result.official_domain.toLowerCase(), company.id, timestamp, candidate.id);
    return { status: "enriched", company_id: company.id };
  }

  if (!candidate.extracted_company_name) return { status: "held", reason: "no_company_name_extracted" };
  const { domain, source } = await resolveDomainFromCompanyName(candidate.extracted_company_name);
  if (!domain) return { status: "held", reason: "free_domain_resolution_failed" };
  const timestamp = nowIso();
  const company = await upsertCompany(env, { company_name: candidate.extracted_company_name, company_domain: domain }, timestamp);
  const sourceKey = `candidate:${candidate.id}`;
  const evidenceExcerpt = `${candidate.title} ${candidate.summary || ""}`.trim().slice(0, 1000);
  await run(env.DB, `INSERT OR IGNORE INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,event_date,published_at,retrieved_at,evidence_excerpt,confidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("sig"), company.id, candidate.source_url, `automated discovery (free domain resolution via ${source})`, sourceKey, candidate.title, candidate.summary, candidate.extracted_event_type || "business_signal", null, candidate.published_at || null, timestamp, evidenceExcerpt, "single_source", timestamp);
  await run(env.DB, "UPDATE discovery_candidates SET status='enriched',extracted_domain=?,company_id=?,updated_at=? WHERE id=?", domain, company.id, timestamp, candidate.id);
  await discoverContactsFromWebsite(env, company).catch(() => {});
  return { status: "enriched", company_id: company.id, via: "free_domain_resolution" };
}

async function runDiscovery(env) {
  if (env.DISCOVERY_ENABLED !== "true") return { disabled: true, sources: 0, candidates: 0, enriched: 0 };
  await bootstrapSources(env); const timestamp = nowIso();
  const sources = await all(env.DB, "SELECT * FROM discovery_sources WHERE enabled=1"); let added = 0; let enriched = 0;
  const yc = [];
  for (const source of sources) {
    if (source.last_run_at && Date.parse(timestamp) - Date.parse(source.last_run_at) < source.interval_minutes * 60_000) continue;
    if (source.provider_type === "yc_directory") { yc.push(await runYcDiscovery(env, source)); continue; }
    const runId = await startRun(env, source.provider_type || "rss_headline", source.id);
    let found = 0, isNew = 0, duplicate = 0, failed = 0;
    try {
      const response = await fetch(source.url, { headers: { "user-agent": "ArgmaxOutreachResearch/0.1 (+https://argmax.one)" }, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text(); if (body.length > 1_000_000) throw new Error("Feed response exceeds 1 MB");
      const items = parseRss(body); found = items.length;
      for (const item of items) { const isFirst = await addCandidate(env, source, item); if (isFirst) { added += 1; isNew += 1; } else duplicate += 1; }
      await run(env.DB, "UPDATE discovery_sources SET last_run_at=?,last_error=NULL,updated_at=? WHERE id=?", timestamp, timestamp, source.id);
      await finishRun(env, runId, { found, new: isNew, duplicate, failed });
    } catch (cause) {
      await run(env.DB, "UPDATE discovery_sources SET last_error=?,updated_at=? WHERE id=?", String(cause.message).slice(0, 500), timestamp, source.id);
      await finishRun(env, runId, { error: String(cause.message).slice(0, 500) });
      await insertNotification(env, { type: "DISCOVERY_ERROR", companyName: "", extra: { provider: source.name, message: cause.message } });
    }
  }
  const providerImported = await importFundingProvider(env);
  const enrichmentMode = env.ENRICHMENT_API_URL && env.ENRICHMENT_API_TOKEN ? "paid_provider" : "free_domain_resolution";
  const candidates = await all(env.DB, "SELECT * FROM discovery_candidates WHERE status='new' ORDER BY retrieved_at LIMIT 20");
  for (const candidate of candidates) { const outcome = await enrichCandidate(env, candidate); if (outcome.status === "enriched") enriched += 1; else await run(env.DB, "UPDATE discovery_candidates SET status='held',rejection_reason=?,updated_at=? WHERE id=?", outcome.reason, nowIso(), candidate.id); }
  return { disabled: false, sources: sources.length, candidates: added, enriched, provider_imported: providerImported, yc, enrichment: enrichmentMode };
}

/**
 * Imports a small page of verified records from a licensed funding-data connector.
 * The connector contract is documented in README; provider credentials stay outside
 * this Worker, so it can support Crunchbase, Dealroom, or a future provider.
 */
async function importFundingProvider(env) {
  if (!env.FUNDING_PROVIDER_API_URL || !env.FUNDING_PROVIDER_API_TOKEN) return 0;
  const lastSync = await one(env.DB, "SELECT MAX(occurred_at) AS occurred_at FROM usage_ledger WHERE provider='funding_provider' AND usage_type='sync'");
  if (lastSync?.occurred_at && Date.now() - Date.parse(lastSync.occurred_at) < 12 * 60 * 60 * 1000) return 0;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const runId = await startRun(env, "funding_provider", null);
  let response;
  try {
    response = await fetch(env.FUNDING_PROVIDER_API_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.FUNDING_PROVIDER_API_TOKEN}` }, body: JSON.stringify({ operation: "recent_funding", since, max_results: 100, filters: { employee_max: 250, excluded_company_sizes: ["enterprise"] } }) });
  } catch (cause) { console.error("Funding provider request failed", cause); await finishRun(env, runId, { error: cause.message }); await insertNotification(env, { type: "DISCOVERY_ERROR", companyName: "", extra: { provider: "funding_provider", message: cause.message } }); return 0; }
  if (!response.ok) { console.error("Funding provider response", response.status); await finishRun(env, runId, { error: `HTTP ${response.status}` }); return 0; }
  let payload; try { payload = await response.json(); } catch { await finishRun(env, runId, { error: "invalid_json" }); return 0; }
  if (!Array.isArray(payload?.items)) { await finishRun(env, runId, { found: 0 }); return 0; }
  let imported = 0; const timestamp = nowIso();
  for (const item of payload.items.slice(0, 100)) {
    try {
      if (!item?.verified || typeof item.company_name !== "string" || typeof item.official_domain !== "string" || typeof item.source_url !== "string" || typeof item.evidence_excerpt !== "string") continue;
      const sourceUrl = safeUrl(item.source_url); const domain = item.official_domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) continue;
      const company = await upsertCompany(env, { company_name: item.company_name, company_domain: domain, country_code: item.country_code, employee_band: item.employee_band }, timestamp);
      const sourceKey = `provider:${item.provider_record_id || sourceUrl}`;
      const result = await run(env.DB, `INSERT OR IGNORE INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,event_date,published_at,retrieved_at,evidence_excerpt,confidence,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("sig"), company.id, sourceUrl, item.source_name || "licensed funding provider", sourceKey.slice(0, 1000), item.title || `${item.company_name} funding event`, item.summary || item.evidence_excerpt, "funding", item.event_date || null, item.published_at || null, timestamp, item.evidence_excerpt, "corroborated", timestamp);
      if (result.meta?.changes) { imported += 1; await recordActivity(env, "COMPANY_DISCOVERED", `New funding signal: ${company.name}`, company.id, { source: "funding_provider" }); }
    } catch (cause) { console.error("Funding provider record skipped", cause); }
  }
  await run(env.DB, "INSERT INTO usage_ledger (id,provider,usage_type,amount,occurred_at,notes) VALUES (?,?,?,?,?,?)", id("usage"), "funding_provider", "sync", imported, timestamp, "successful provider poll");
  await finishRun(env, runId, { found: payload.items.length, new: imported });
  return imported;
}

async function ingestSignal(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const company = await upsertCompany(env, data, timestamp);
  const sourceUrl = safeUrl(requiredString(data.source_url, "source_url"));
  const sourceKey = requiredString(data.source_key, "source_key");
  const existing = await one(env.DB, "SELECT * FROM signals WHERE company_id = ? AND source_key = ?", company.id, sourceKey);
  if (existing) return json({ company, signal: existing, duplicate: true }, 200);
  const signal = { id: id("sig"), sourceName: requiredString(data.source_name, "source_name"), title: requiredString(data.title, "title"), summary: requiredString(data.summary, "summary"), eventType: requiredString(data.event_type, "event_type"), excerpt: requiredString(data.evidence_excerpt, "evidence_excerpt") };
  await run(env.DB, `INSERT INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,event_date,published_at,retrieved_at,evidence_excerpt,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, signal.id, company.id, sourceUrl, signal.sourceName, sourceKey, signal.title, signal.summary, signal.eventType, data.event_date || null, data.published_at || null, timestamp, signal.excerpt, timestamp);
  return json({ company, signal: await one(env.DB, "SELECT * FROM signals WHERE id=?", signal.id) }, 201);
}

async function createContact(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const company = await companyById(env, requiredString(data.company_id, "company_id"));
  if (!company) return error("Company not found", 404);
  const email = requiredString(data.email, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("email is invalid");
  const prior = await one(env.DB, "SELECT * FROM contacts WHERE email=?", email);
  if (prior) return error("Email already exists", 409);
  const verification = data.verification_status || "unknown";
  const policy = data.policy_status || "hold";
  const contact = { id: id("ct"), email, firstName: data.first_name || null, lastName: data.last_name || null, title: data.title || null, evidence: data.role_evidence_url ? safeUrl(data.role_evidence_url) : null, source: data.email_source || null, verification, policy, basis: data.contact_basis || "unknown", country: (data.country_code || company.country_code || "").toUpperCase() || null };
  await run(env.DB, `INSERT INTO contacts (id,company_id,email,first_name,last_name,title,role_evidence_url,email_source,verification_status,verified_at,contact_basis,policy_status,country_code,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, contact.id, company.id, contact.email, contact.firstName, contact.lastName, contact.title, contact.evidence, contact.source, contact.verification, verification === "valid" ? timestamp : null, contact.basis, contact.policy, contact.country, timestamp, timestamp);
  return json({ contact: await contactById(env, contact.id) }, 201);
}

async function qualify(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const company = await companyById(env, requiredString(data.company_id, "company_id"));
  const contact = await contactById(env, requiredString(data.contact_id, "contact_id"));
  if (!company || !contact || contact.company_id !== company.id) return error("Company/contact mismatch", 404);
  const decision = qualificationDecision(data.scores || {}, contact);
  const proof = data.proof_id || null;
  const hypothesis = data.need_hypothesis || null; const offer = data.bounded_offer || null;
  const existing = await one(env.DB, "SELECT company_id FROM qualifications WHERE company_id=?", company.id);
  const values = [data.scores.need, data.scores.fit, data.scores.stability, data.scores.timing, data.scores.access, data.scores.practicality, decision.total, hypothesis, offer, proof, data.reviewed_by || null, timestamp, timestamp];
  if (existing) await run(env.DB, `UPDATE qualifications SET need_score=?,fit_score=?,stability_score=?,timing_score=?,access_score=?,practicality_score=?,total_score=?,need_hypothesis=?,bounded_offer=?,proof_id=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE company_id=?`, ...values, company.id);
  else await run(env.DB, `INSERT INTO qualifications (company_id,need_score,fit_score,stability_score,timing_score,access_score,practicality_score,total_score,need_hypothesis,bounded_offer,proof_id,reviewed_by,reviewed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, company.id, ...values.slice(0, 12), timestamp, timestamp);
  await run(env.DB, "UPDATE companies SET status=?,updated_at=? WHERE id=?", decision.status, timestamp, company.id);
  return json({ decision, qualification: await one(env.DB, "SELECT * FROM qualifications WHERE company_id=?", company.id) });
}

async function createTemplate(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const required = Array.isArray(data.required_fields) ? data.required_fields : REQUIRED_PERSONALIZATION_FIELDS;
  for (const field of required) if (!/^[a-z_]+$/.test(field)) return error(`Invalid template field ${field}`);
  const template = { id: id("tpl"), name: requiredString(data.name, "name"), version: Number(data.version), subject: requiredString(data.subject, "subject"), body: requiredString(data.body, "body") };
  if (!Number.isInteger(template.version) || template.version < 1) return error("version must be a positive integer");
  renderTemplate({ ...template, required_fields_json: JSON.stringify(required) }, Object.fromEntries(required.map((field) => [field, "reviewed value"])));
  await run(env.DB, "INSERT INTO templates (id,name,version,subject,body,required_fields_json,active,created_at) VALUES (?,?,?,?,?,?,?,?)", template.id, template.name, template.version, template.subject, template.body, JSON.stringify(required), data.active ? 1 : 0, timestamp);
  return json({ template: await one(env.DB, "SELECT * FROM templates WHERE id=?", template.id) }, 201);
}

async function createCampaign(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const template = await one(env.DB, "SELECT * FROM templates WHERE id=?", requiredString(data.template_id, "template_id"));
  if (!template) return error("Template not found", 404);
  const limit = Number(data.daily_limit ?? env.DAILY_SEND_LIMIT ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error("daily_limit must be 1–100");
  const campaign = { id: id("cmp"), name: requiredString(data.name, "name"), countries: Array.isArray(data.country_codes) ? data.country_codes.map((x) => x.toUpperCase()) : [], limit };
  await run(env.DB, "INSERT INTO campaigns (id,name,template_id,status,country_codes_json,daily_limit,requires_approval,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", campaign.id, campaign.name, template.id, "draft", JSON.stringify(campaign.countries), campaign.limit, data.requires_approval === false ? 0 : 1, timestamp, timestamp);
  return json({ campaign: await one(env.DB, "SELECT * FROM campaigns WHERE id=?", campaign.id) }, 201);
}

async function setCampaignStatus(request, env, campaignId) {
  const data = await readJson(request); const timestamp = nowIso();
  const status = requiredString(data.status, "status");
  if (!["draft", "active", "paused", "archived"].includes(status)) return error("Invalid campaign status");
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id=?", campaignId);
  if (!campaign) return error("Campaign not found", 404);
  if (status === "active" && campaign.status === "archived") return error("Archived campaigns cannot be reactivated", 409);
  await run(env.DB, "UPDATE campaigns SET status=?,updated_at=? WHERE id=?", status, timestamp, campaignId);
  if (status === "paused" || status === "archived") {
    await run(env.DB, "UPDATE outbox SET status='cancelled',error=?,updated_at=? WHERE campaign_id=? AND status='pending'", `campaign_${status}`, timestamp, campaignId);
  }
  return json({ campaign: await one(env.DB, "SELECT * FROM campaigns WHERE id=?", campaignId) });
}

async function createEnrollment(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id=?", requiredString(data.campaign_id, "campaign_id"));
  const contact = await contactById(env, requiredString(data.contact_id, "contact_id"));
  if (!campaign || !contact) return error("Campaign or contact not found", 404);
  const company = await companyById(env, contact.company_id);
  if (company.owner_campaign_id && company.owner_campaign_id !== campaign.id) return error("Company already belongs to another campaign", 409);
  const existing = await one(env.DB, "SELECT * FROM enrollments WHERE campaign_id=? AND contact_id=?", campaign.id, contact.id);
  if (existing) return json({ enrollment: existing, duplicate: true });
  const allowedCountries = JSON.parse(campaign.country_codes_json);
  let status = "draft", holdReason = null;
  if (company.status !== "qualified") { status = "held"; holdReason = "company_not_qualified"; }
  else if (allowedCountries.length && !allowedCountries.includes(contact.country_code)) { status = "held"; holdReason = "country_not_enabled"; }
  const enrollment = { id: id("enr"), status, holdReason };
  await run(env.DB, "INSERT INTO enrollments (id,campaign_id,company_id,contact_id,status,hold_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", enrollment.id, campaign.id, company.id, contact.id, enrollment.status, enrollment.holdReason, timestamp, timestamp);
  if (status !== "held") await run(env.DB, "UPDATE companies SET owner_campaign_id=?,updated_at=? WHERE id=?", campaign.id, timestamp, company.id);
  return json({ enrollment: await one(env.DB, "SELECT * FROM enrollments WHERE id=?", enrollment.id) }, 201);
}

async function approveEnrollment(request, env, enrollmentId) {
  const data = await readJson(request); const timestamp = nowIso();
  const enrollment = await one(env.DB, "SELECT * FROM enrollments WHERE id=?", enrollmentId);
  if (!enrollment) return error("Enrollment not found", 404);
  if (enrollment.status !== "draft") return error("Only draft enrollments can be approved", 409);
  await run(env.DB, "UPDATE enrollments SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=?", requiredString(data.approved_by, "approved_by"), timestamp, timestamp, enrollment.id);
  return json({ enrollment: await one(env.DB, "SELECT * FROM enrollments WHERE id=?", enrollment.id) });
}

async function scheduleOutbox(request, env) {
  const data = await readJson(request); const timestamp = nowIso();
  const enrollment = await one(env.DB, "SELECT * FROM enrollments WHERE id=?", requiredString(data.enrollment_id, "enrollment_id"));
  if (!enrollment) return error("Enrollment not found", 404);
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id=?", enrollment.campaign_id);
  const template = await one(env.DB, "SELECT * FROM templates WHERE id=?", campaign.template_id);
  const contact = await contactById(env, enrollment.contact_id); const company = await companyById(env, enrollment.company_id);
  if (enrollment.status !== "approved" && !(campaign.requires_approval === 0 && enrollment.status === "draft")) return error("Enrollment is not approved", 409);
  const step = Number(data.step ?? 1); if (!Number.isInteger(step) || step < 1 || step > 3) return error("step must be 1–3");
  const scheduledFor = new Date(requiredString(data.scheduled_for, "scheduled_for")); if (Number.isNaN(scheduledFor.valueOf())) return error("scheduled_for is invalid");
  const rendered = renderTemplate(template, { ...data.fields, company: data.fields?.company || company.name, first_name: data.fields?.first_name || contact.first_name || "there" });
  const outboxId = id("msg");
  try {
    await run(env.DB, `INSERT INTO outbox (id,enrollment_id,campaign_id,contact_id,step,scheduled_for,idempotency_key,rendered_subject,rendered_body,policy_version,template_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, outboxId, enrollment.id, campaign.id, contact.id, step, scheduledFor.toISOString(), `${enrollment.id}:step:${step}`, rendered.subject, rendered.body, requiredString(data.policy_version, "policy_version"), template.version, timestamp, timestamp);
  } catch (cause) { if (String(cause.message).includes("UNIQUE")) return error("A message for this enrollment step already exists", 409); throw cause; }
  await run(env.DB, "UPDATE enrollments SET status='scheduled',current_step=?,updated_at=? WHERE id=?", step, timestamp, enrollment.id);
  return json({ outbox: await one(env.DB, "SELECT * FROM outbox WHERE id=?", outboxId) }, 201);
}

async function suppress(env, { email, companyId, reason, source }) {
  const timestamp = nowIso(); const idValue = id("sup");
  if (email) await run(env.DB, "INSERT OR IGNORE INTO suppressions (id,email,reason,source,created_at) VALUES (?,?,?,?,?)", idValue, email.toLowerCase(), reason, source, timestamp);
  if (companyId) await run(env.DB, "INSERT OR IGNORE INTO suppressions (id,company_id,reason,source,created_at) VALUES (?,?,?,?,?)", id("sup"), companyId, reason, source, timestamp);
  if (email) await run(env.DB, "UPDATE contacts SET policy_status='blocked',updated_at=? WHERE email=?", timestamp, email.toLowerCase());
  if (companyId) await run(env.DB, "UPDATE companies SET status='suppressed',updated_at=? WHERE id=?", timestamp, companyId);
  if (email || companyId) await run(env.DB, `UPDATE outbox SET status='cancelled',updated_at=? WHERE status='pending' AND (contact_id IN (SELECT id FROM contacts WHERE email=?) OR enrollment_id IN (SELECT id FROM enrollments WHERE company_id=?))`, timestamp, email?.toLowerCase() || "", companyId || "");
}

async function providerEvent(request, env) {
  requireWebhook(request, env); const data = await readJson(request); const timestamp = nowIso();
  const providerEventId = requiredString(data.provider_event_id, "provider_event_id"); const eventType = requiredString(data.event_type, "event_type");
  const existing = await one(env.DB, "SELECT * FROM message_events WHERE provider_event_id=?", providerEventId);
  if (existing) return json({ event: existing, duplicate: true });
  const outbox = data.outbox_id ? await one(env.DB, "SELECT * FROM outbox WHERE id=?", data.outbox_id) : null;
  await run(env.DB, "INSERT INTO message_events (id,outbox_id,provider_event_id,event_type,payload_json,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)", id("evt"), outbox?.id || null, providerEventId, eventType, JSON.stringify(data.payload || {}), data.occurred_at || timestamp, timestamp);
  if (outbox && eventAction(eventType) === "suppress") {
    const contact = await contactById(env, outbox.contact_id); const enrollment = await one(env.DB, "SELECT * FROM enrollments WHERE id=?", outbox.enrollment_id);
    const company = await companyById(env, enrollment.company_id);
    await suppress(env, { email: contact.email, companyId: enrollment.company_id, reason: eventType, source: "provider_event" });
    await run(env.DB, "UPDATE enrollments SET status=?,updated_at=? WHERE id=?", eventType === "reply" ? "replied" : "suppressed", timestamp, enrollment.id);
    if (eventType === "reply") {
      await recordActivity(env, "EMAIL_REPLIED", `Reply received from ${company.name}`, company.id, {});
      await insertNotification(env, { type: "REPLY_RECEIVED", companyId: company.id, companyName: company.name, extra: {} });
    } else {
      await recordActivity(env, eventType === "unsubscribe" ? "CONTACT_UNSUBSCRIBED" : "EMAIL_BOUNCED", `${eventType} for ${company.name}`, company.id, {});
      await insertNotification(env, { type: eventType === "unsubscribe" ? "UNSUBSCRIBE" : "BOUNCE", companyId: company.id, companyName: company.name, extra: {} });
    }
  }
  return json({ received: true }, 201);
}

async function dispatchOutbox(env, outboxId) {
  const timestamp = nowIso();
  const outbox = await one(env.DB, "SELECT * FROM outbox WHERE id=?", outboxId);
  if (!outbox) return { status: "missing" };
  const enrollment = await one(env.DB, "SELECT * FROM enrollments WHERE id=?", outbox.enrollment_id);
  const campaign = await one(env.DB, "SELECT * FROM campaigns WHERE id=?", outbox.campaign_id);
  const contact = await contactById(env, outbox.contact_id); const company = await companyById(env, enrollment.company_id);
  const suppressions = await all(env.DB, "SELECT email,company_id FROM suppressions WHERE email=? OR company_id=?", contact.email, company.id);
  const dayStart = timestamp.slice(0, 10) + "T00:00:00.000Z";
  const sentToday = (await one(env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE campaign_id=? AND status IN ('accepted','dry_run') AND accepted_at>=?", campaign.id, dayStart)).count;
  const replySync = await one(env.DB, "SELECT MAX(occurred_at) AS last_sync FROM message_events WHERE event_type='reply_sync'", );
  const maxAge = Number(env.REPLY_SYNC_MAX_AGE_MINUTES || 30) * 60 * 1000;
  const replySyncFresh = !!replySync?.last_sync && Date.parse(timestamp) - Date.parse(replySync.last_sync) <= maxAge;
  const denied = canDispatch({ enrollment, campaign, contact, company, outbox, suppressions, sendMode: env.SEND_MODE || "dry_run", replySyncFresh, sentToday, globalLimit: Number(env.DAILY_SEND_LIMIT || 10), now: timestamp });
  if (denied) { await run(env.DB, "UPDATE outbox SET status='cancelled',error=?,updated_at=? WHERE id=? AND status='pending'", denied, timestamp, outbox.id); return { status: "blocked", reason: denied }; }
  const claim = await run(env.DB, "UPDATE outbox SET status='claimed',claimed_at=?,updated_at=? WHERE id=? AND status='pending'", timestamp, timestamp, outbox.id);
  if (!claim.meta?.changes) return { status: "already_claimed" };
  if ((env.SEND_MODE || "dry_run") === "dry_run") { await run(env.DB, "UPDATE outbox SET status='dry_run',accepted_at=?,updated_at=? WHERE id=?", timestamp, timestamp, outbox.id); return { status: "dry_run" }; }
  try {
    if (!env.EMAIL_API_URL || !env.EMAIL_API_TOKEN || !env.SENDER_EMAIL) throw new Error("Live email adapter is not configured");
    const response = await fetch(env.EMAIL_API_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.EMAIL_API_TOKEN}`, "idempotency-key": outbox.idempotency_key }, body: JSON.stringify({ from: { email: env.SENDER_EMAIL, name: env.SENDER_NAME || "Argmax Studio" }, to: [{ email: contact.email }], subject: outbox.rendered_subject, text: outbox.rendered_body, reply_to: env.SENDER_EMAIL }) });
    const responseText = await response.text(); if (!response.ok) throw new Error(`Provider ${response.status}: ${responseText.slice(0, 500)}`);
    let parsed = {}; try { parsed = JSON.parse(responseText); } catch { /* provider may return empty */ }
    await run(env.DB, "UPDATE outbox SET status='accepted',provider_message_id=?,accepted_at=?,updated_at=? WHERE id=?", parsed.id || parsed.message_id || null, timestamp, timestamp, outbox.id);
    return { status: "accepted" };
  } catch (cause) {
    await run(env.DB, "UPDATE outbox SET status='send_unknown',error=?,updated_at=? WHERE id=?", String(cause.message).slice(0, 1000), timestamp, outbox.id);
    return { status: "send_unknown" };
  }
}

async function enqueueDue(env) {
  const due = await all(env.DB, "SELECT id FROM outbox WHERE status='pending' AND scheduled_for<=? ORDER BY scheduled_for LIMIT 100", nowIso());
  for (const item of due) await env.OUTREACH_QUEUE.send({ type: "dispatch", outbox_id: item.id });
  return due.length;
}

async function dashboard(env) {
  const todayStart = nowIso().slice(0, 10) + "T00:00:00.000Z";
  const [companies, enrollments, outbox, candidates, suppressions, newToday, unreadNotifications, topSources, recentRuns, recentActivity] = await Promise.all([
    all(env.DB, "SELECT status,COUNT(*) AS count FROM companies GROUP BY status"), all(env.DB, "SELECT status,COUNT(*) AS count FROM enrollments GROUP BY status"),
    all(env.DB, "SELECT status,COUNT(*) AS count FROM outbox GROUP BY status"), all(env.DB, "SELECT status,COUNT(*) AS count FROM discovery_candidates GROUP BY status"),
    one(env.DB, "SELECT COUNT(*) AS count FROM suppressions"), one(env.DB, "SELECT COUNT(*) AS count FROM companies WHERE created_at>=?", todayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM notifications WHERE read=0"),
    all(env.DB, "SELECT ds.provider_type AS provider_type, COUNT(*) AS count FROM discovery_candidates dc JOIN discovery_sources ds ON ds.id=dc.source_id GROUP BY ds.provider_type ORDER BY count DESC"),
    all(env.DB, "SELECT id,provider,status,items_found,items_new,started_at,completed_at FROM discovery_runs ORDER BY started_at DESC LIMIT 10"),
    all(env.DB, "SELECT type,summary,company_id,created_at FROM activity_events ORDER BY created_at DESC LIMIT 20")
  ]);
  return json({
    send_mode: env.SEND_MODE || "dry_run", companies, enrollments, outbox, candidates, suppressions: suppressions.count,
    new_companies_today: newToday.count, unread_notifications: unreadNotifications.count, top_discovery_sources: topSources,
    recent_discovery_runs: recentRuns, recent_activity: recentActivity
  });
}

async function dailyReport(env) {
  const dayStart = nowIso().slice(0, 10) + "T00:00:00.000Z";
  const [companiesTotal, newCompanies, contactsVerified, emailsGenerated, awaitingApproval, emailsSent, replies, bounces, unsubscribes, bySource] = await Promise.all([
    one(env.DB, "SELECT COUNT(*) AS count FROM companies"), one(env.DB, "SELECT COUNT(*) AS count FROM companies WHERE created_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM contacts WHERE verification_status='valid' AND updated_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE created_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM enrollments WHERE status='draft' AND created_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE status IN ('accepted','dry_run') AND accepted_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='reply' AND occurred_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='hard_bounce' AND occurred_at>=?", dayStart),
    one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='unsubscribe' AND occurred_at>=?", dayStart),
    all(env.DB, "SELECT ds.provider_type AS provider_type, COUNT(*) AS count FROM discovery_candidates dc JOIN discovery_sources ds ON ds.id=dc.source_id WHERE dc.created_at>=? GROUP BY ds.provider_type", dayStart)
  ]);
  return json({
    date: dayStart.slice(0, 10), companies_discovered: newCompanies.count, companies_total: companiesTotal.count, contacts_verified: contactsVerified.count,
    emails_generated: emailsGenerated.count, awaiting_approval: awaitingApproval.count, emails_sent: emailsSent.count, replies: replies.count,
    bounces: bounces.count, unsubscribes: unsubscribes.count, by_source: bySource
  });
}

async function listCompanies(env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const offset = Number(url.searchParams.get("offset") || 0);
  const status = url.searchParams.get("status");
  const rows = status
    ? await all(env.DB, "SELECT * FROM companies WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?", status, limit, offset)
    : await all(env.DB, "SELECT * FROM companies ORDER BY created_at DESC LIMIT ? OFFSET ?", limit, offset);
  return json({ companies: rows });
}

async function companyDetail(env, companyId) {
  const company = await companyById(env, companyId);
  if (!company) return error("Company not found", 404);
  const [signals, contacts, qualification, research, reason, enrollments] = await Promise.all([
    all(env.DB, "SELECT * FROM signals WHERE company_id=? ORDER BY retrieved_at DESC", companyId),
    all(env.DB, "SELECT * FROM contacts WHERE company_id=?", companyId),
    one(env.DB, "SELECT * FROM qualifications WHERE company_id=?", companyId),
    one(env.DB, "SELECT * FROM research_reports WHERE company_id=?", companyId),
    one(env.DB, "SELECT * FROM lead_reasons WHERE company_id=?", companyId),
    all(env.DB, "SELECT * FROM enrollments WHERE company_id=?", companyId)
  ]);
  return json({ company, signals, contacts, qualification, research, lead_reason: reason, enrollments });
}

async function listDiscoverySources(env) { return json({ sources: await all(env.DB, "SELECT * FROM discovery_sources ORDER BY name") }); }

async function toggleDiscoverySource(request, env, sourceId) {
  const data = await readJson(request);
  if (typeof data.enabled !== "boolean") return error("enabled (boolean) is required");
  const source = await one(env.DB, "SELECT * FROM discovery_sources WHERE id=?", sourceId);
  if (!source) return error("Discovery source not found", 404);
  await run(env.DB, "UPDATE discovery_sources SET enabled=?,updated_at=? WHERE id=?", data.enabled ? 1 : 0, nowIso(), sourceId);
  return json({ source: await one(env.DB, "SELECT * FROM discovery_sources WHERE id=?", sourceId) });
}

async function listDiscoveryRuns(env) { return json({ runs: await all(env.DB, "SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 50") }); }

async function triggerContactDiscovery(env, companyId) {
  const company = await companyById(env, companyId);
  if (!company) return error("Company not found", 404);
  const outcome = await discoverContactsFromWebsite(env, company);
  return json({ company_id: companyId, ...outcome, contacts: await all(env.DB, "SELECT * FROM contacts WHERE company_id=?", companyId) });
}

async function triggerResearch(env, companyId) {
  const outcome = await runResearch(env, companyId);
  if (!outcome) return error("Company not found", 404);
  return json({ company: outcome.company, research: outcome.reason, score: outcome.score, evidence: outcome.evidence, notification: outcome.notification, ai_research: outcome.ai_research, ai_meta: outcome.ai_meta });
}

async function listNotifications(env, url) {
  const unreadOnly = url.searchParams.get("unread") === "true";
  const rows = unreadOnly
    ? await all(env.DB, "SELECT * FROM notifications WHERE read=0 ORDER BY created_at DESC LIMIT 100")
    : await all(env.DB, "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100");
  return json({ notifications: rows });
}

async function markNotificationRead(env, notificationId) {
  const notification = await one(env.DB, "SELECT * FROM notifications WHERE id=?", notificationId);
  if (!notification) return error("Notification not found", 404);
  await run(env.DB, "UPDATE notifications SET read=1 WHERE id=?", notificationId);
  return json({ notification: await one(env.DB, "SELECT * FROM notifications WHERE id=?", notificationId) });
}

async function listActivity(env) { return json({ activity: await all(env.DB, "SELECT * FROM activity_events ORDER BY created_at DESC LIMIT 100") }); }

/**
 * Real personalization + claim-validation pipeline (spec §10/§11). Generates a
 * draft via the configured AI provider (never auto-sends -- AUTO_SEND_ENABLED
 * defaults false and there is no code path from here into the outbox), then
 * runs a second AI call to check every factual claim in the draft against the
 * same evidence used for research. An email with any UNSUPPORTED or UNCERTAIN
 * claim is stored but marked invalid=false, blocking a human from mistaking it
 * for send-ready; a human still reviews/approves through the existing
 * enrollment/outbox pipeline regardless of this result.
 */
async function generateEmail(env, companyId, contactId) {
  const company = await companyById(env, companyId);
  if (!company) return error("Company not found", 404);
  const contact = contactId ? await contactById(env, contactId) : await one(env.DB, "SELECT * FROM contacts WHERE company_id=? ORDER BY created_at LIMIT 1", companyId);
  const research = await one(env.DB, "SELECT * FROM research_reports WHERE company_id=?", companyId);
  if (!research) return error("Run POST /api/leads/:companyId/research before generating an email", 409);
  const argmaxServices = JSON.parse(research.argmax_services_json || "[]").map((n) => n.service || n);
  const { system, user } = buildPersonalizationPrompt({ company, contact, research, argmaxServices });
  const draftResult = await callAIWithFallback(env, { operation: "personalization", systemPrompt: system, userPrompt: user, maxOutputTokens: Number(env.AI_MAX_OUTPUT_TOKENS ?? 800) });
  if (!draftResult) return error("No AI provider is configured or all configured providers failed; cannot generate a personalized draft", 503);
  const draft = parseAIJson(draftResult.text);
  if (!draft || typeof draft.subject !== "string" || typeof draft.body !== "string") return error("AI provider returned an unparseable draft", 502);

  const evidence = JSON.parse(research.evidence_json || "[]");
  const { system: valSystem, user: valUser } = buildClaimValidationPrompt({ emailBody: draft.body, evidence });
  const validationResult = await callAIWithFallback(env, { operation: "claim_validation", systemPrompt: valSystem, userPrompt: valUser, maxOutputTokens: Number(env.AI_MAX_OUTPUT_TOKENS ?? 800) });
  const validationParsed = validationResult ? parseAIJson(validationResult.text) : null;
  const validation = evaluateClaimValidation(validationParsed);

  const draftId = id("draft"); const timestamp = nowIso();
  await run(env.DB, `INSERT INTO email_drafts (id,company_id,contact_id,subject,body,personalization_points_json,claims_used_json,validation_json,valid,ai_provider,ai_model,generated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    draftId, companyId, contact?.id || null, draft.subject, draft.body, JSON.stringify(draft.personalization_points || []), JSON.stringify(draft.claims_used || []),
    JSON.stringify(validationParsed || {}), validation.valid ? 1 : 0, draftResult.provider, draftResult.model, timestamp);
  await recordActivity(env, "EMAIL_GENERATED", `Email draft generated for ${company.name} (${validation.valid ? "claims supported" : "BLOCKED: unsupported claims"})`, companyId, { valid: validation.valid });
  if (!validation.valid) await insertNotification(env, { type: "EMAIL_READY_FOR_APPROVAL", companyId, companyName: company.name, extra: { message: `Draft for ${company.name} was generated but blocked: ${validation.reason}. It needs manual review, not just approval.` } });
  else await insertNotification(env, { type: "EMAIL_READY_FOR_APPROVAL", companyId, companyName: company.name, extra: { message: `A personalized draft for ${company.name} passed claim validation and is ready for human review.` } });
  return json({ draft_id: draftId, subject: draft.subject, body: draft.body, personalization_points: draft.personalization_points || [], claims_used: draft.claims_used || [], validation, provider: draftResult.provider, model: draftResult.model });
}

async function listEmailDrafts(env, companyId) { return json({ drafts: await all(env.DB, "SELECT * FROM email_drafts WHERE company_id=? ORDER BY generated_at DESC", companyId) }); }

/**
 * Real CompanyEnrichmentProvider endpoint. Uses the paid ENRICHMENT_API_URL
 * adapter if configured (same contract as enrichCandidate above); otherwise
 * falls back to the free, no-API-key website-based provider in
 * src/enrichment.js, so enrichment is never a hard dependency (spec §19).
 */
async function triggerCompanyEnrichment(env, companyId) {
  const company = await companyById(env, companyId);
  if (!company) return error("Company not found", 404);
  const enrichment = await enrichCompanyFromWebsite(company);
  const timestamp = nowIso();
  if (enrichment.employeeCount || enrichment.technologies?.length) {
    const excerpt = `Free website enrichment: ${enrichment.employeeCount ? `~${enrichment.employeeCount} employees mentioned. ` : ""}${enrichment.technologies?.length ? `Technology mentions: ${enrichment.technologies.join(", ")}.` : ""}`.trim();
    await run(env.DB, `INSERT OR IGNORE INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,event_date,published_at,retrieved_at,evidence_excerpt,confidence,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id("sig"), companyId, enrichment.sourceUrls[0] || null, "website_enrichment", `enrichment:${companyId}:${timestamp}`, `${company.name} — website enrichment`, excerpt, "enrichment", null, null, timestamp, excerpt, "single_source", timestamp);
    await recordActivity(env, "COMPANY_ENRICHED", `${company.name} enriched from its own website`, companyId, enrichment);
  }
  return json({ company_id: companyId, source: "website", enrichment });
}

/**
 * Real EmailVerificationProvider endpoint. Runs the DNS-over-HTTPS MX/A lookup
 * in src/enrichment.js and advances verification_status through the state
 * machine in nextVerificationState -- it can only move a contact out of
 * "pending", never straight from "unknown", keeping the spec §12 ordering intact.
 */
async function verifyContactEmail(env, contactId) {
  const contact = await contactById(env, contactId);
  if (!contact) return error("Contact not found", 404);
  const result = (await verifyEmailViaExternalSmtpService(env, contact.email)) || (await verifyEmailViaDns(contact.email));
  const from = contact.verification_status === "unknown" ? "pending" : contact.verification_status;
  if (contact.verification_status === "unknown") await run(env.DB, "UPDATE contacts SET verification_status='pending',updated_at=? WHERE id=?", nowIso(), contactId);
  let nextState;
  try { nextState = nextVerificationState(from, result.status); }
  catch { return json({ contact_id: contactId, ...result, verification_status: contact.verification_status, note: `DNS check returned "${result.status}" but that is not a valid transition from "${from}"; status left unchanged for a human to review.` }); }
  await run(env.DB, "UPDATE contacts SET verification_status=?,verified_at=?,updated_at=? WHERE id=?", nextState, nowIso(), nowIso(), contactId);
  return json({ contact_id: contactId, ...result, verification_status: nextState });
}

// --- CSV / XLSX export (spec §39/§40) ---------------------------------------------
async function exportCompaniesCsv(env) {
  const rows = await all(env.DB, "SELECT * FROM companies ORDER BY created_at DESC");
  const csv = toCsv(rows, [
    { key: "name", label: "company" }, { key: "domain", label: "domain" }, { key: "status", label: "status" },
    { key: "country_code", label: "country" }, { key: "employee_band", label: "employee_band" }, { key: "created_at", label: "discovered_at" }
  ]);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=companies.csv" } });
}

async function leadExportRows(env) {
  return all(env.DB, `
    SELECT c.name AS company, c.domain AS domain, lr.signal_score AS score, c.status AS status,
           ct.first_name AS contact_first_name, ct.last_name AS contact_last_name, ct.title AS contact_title,
           ct.email AS email, ct.verification_status AS verification_status, c.created_at AS discovered_at
    FROM companies c
    LEFT JOIN lead_reasons lr ON lr.company_id = c.id
    LEFT JOIN contacts ct ON ct.company_id = c.id
    ORDER BY c.created_at DESC`);
}

async function exportLeadsCsv(env) {
  const rows = await leadExportRows(env);
  const csv = toCsv(rows, [
    { key: "company", label: "company" }, { key: "domain", label: "domain" }, { key: "score", label: "qualification_score" },
    { key: "status", label: "status" }, { value: (r) => `${r.contact_first_name || ""} ${r.contact_last_name || ""}`.trim(), label: "contact" },
    { key: "contact_title", label: "title" }, { key: "email", label: "email" }, { key: "verification_status", label: "verification_status" },
    { key: "discovered_at", label: "discovered_at" }
  ]);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=leads.csv" } });
}

async function exportLeadsXlsx(env) {
  const rows = await leadExportRows(env);
  const headers = ["company", "domain", "qualification_score", "status", "contact", "title", "email", "verification_status", "discovered_at"];
  const body = rows.map((r) => [r.company, r.domain, r.score ?? "", r.status, `${r.contact_first_name || ""} ${r.contact_last_name || ""}`.trim(), r.contact_title || "", r.email || "", r.verification_status || "", r.discovered_at]);
  const bytes = buildXlsxWorkbook("Leads", headers, body);
  return new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=leads.xlsx" } });
}

async function exportContactsCsv(env) {
  const rows = await all(env.DB, "SELECT ct.*, c.name AS company_name FROM contacts ct JOIN companies c ON c.id = ct.company_id ORDER BY ct.created_at DESC");
  const csv = toCsv(rows, [
    { key: "company_name", label: "company" }, { key: "first_name", label: "first_name" }, { key: "last_name", label: "last_name" },
    { key: "title", label: "title" }, { key: "email", label: "email" }, { key: "verification_status", label: "verification_status" },
    { key: "contact_basis", label: "basis" }, { key: "created_at", label: "created_at" }
  ]);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=contacts.csv" } });
}

async function exportOutreachCsv(env) {
  const rows = await all(env.DB, `
    SELECT c.name AS company, ct.email AS email, e.status AS enrollment_status, o.status AS outbox_status, o.accepted_at, o.sent_at
    FROM enrollments e JOIN companies c ON c.id = e.company_id JOIN contacts ct ON ct.id = e.contact_id
    LEFT JOIN outbox o ON o.enrollment_id = e.id ORDER BY e.created_at DESC`);
  const csv = toCsv(rows, [
    { key: "company", label: "company" }, { key: "email", label: "email" }, { key: "enrollment_status", label: "enrollment_status" },
    { key: "outbox_status", label: "outbox_status" }, { key: "accepted_at", label: "accepted_at" }, { key: "sent_at", label: "sent_at" }
  ]);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=outreach.csv" } });
}

// --- Analytics (spec §41-46) --------------------------------------------------------
async function analyticsOverview(env) {
  const [companies, qualified, contacts, sent, replies, bounces] = await Promise.all([
    one(env.DB, "SELECT COUNT(*) AS count FROM companies"), one(env.DB, "SELECT COUNT(*) AS count FROM lead_reasons WHERE signal_score>=?", Number(env.LEAD_QUALIFICATION_THRESHOLD || 75)),
    one(env.DB, "SELECT COUNT(*) AS count FROM contacts WHERE verification_status='valid'"), one(env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE status IN ('accepted','dry_run')"),
    one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='reply'"), one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='hard_bounce'")
  ]);
  return json({ companies: companies.count, qualified_leads: qualified.count, verified_contacts: contacts.count, emails_sent: sent.count, replies: replies.count, bounces: bounces.count });
}

async function analyticsFunnel(env) {
  const [discovered, enriched, qualified, contactFound, contactVerified, researched, drafted, approved, sent, delivered, replied] = await Promise.all([
    one(env.DB, "SELECT COUNT(*) AS count FROM companies"),
    one(env.DB, "SELECT COUNT(DISTINCT company_id) AS count FROM signals"),
    one(env.DB, "SELECT COUNT(*) AS count FROM lead_reasons WHERE signal_score>=?", Number(env.LEAD_QUALIFICATION_THRESHOLD || 75)),
    one(env.DB, "SELECT COUNT(DISTINCT company_id) AS count FROM contacts"),
    one(env.DB, "SELECT COUNT(DISTINCT company_id) AS count FROM contacts WHERE verification_status='valid'"),
    one(env.DB, "SELECT COUNT(*) AS count FROM research_reports"),
    one(env.DB, "SELECT COUNT(DISTINCT company_id) AS count FROM email_drafts"),
    one(env.DB, "SELECT COUNT(*) AS count FROM enrollments WHERE status='approved'"),
    one(env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE status IN ('accepted','dry_run')"),
    one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='delivered'"),
    one(env.DB, "SELECT COUNT(*) AS count FROM message_events WHERE event_type='reply'")
  ]);
  const stages = { discovered: discovered.count, enriched: enriched.count, qualified: qualified.count, contact_found: contactFound.count, contact_verified: contactVerified.count, research_completed: researched.count, email_drafted: drafted.count, approved: approved.count, sent: sent.count, delivered: delivered.count, replied: replied.count };
  return json({ stages });
}

async function analyticsSources(env) {
  const rows = await all(env.DB, `
    SELECT ds.provider_type AS provider_type, COUNT(DISTINCT dc.company_id) AS companies,
           SUM(CASE WHEN lr.signal_score >= ? THEN 1 ELSE 0 END) AS qualified
    FROM discovery_candidates dc JOIN discovery_sources ds ON ds.id = dc.source_id
    LEFT JOIN lead_reasons lr ON lr.company_id = dc.company_id
    GROUP BY ds.provider_type`, Number(env.LEAD_QUALIFICATION_THRESHOLD || 75));
  return json({ sources: rows });
}

async function analyticsCampaigns(env) {
  const rows = await all(env.DB, `
    SELECT camp.name AS campaign, COUNT(DISTINCT e.id) AS leads,
           SUM(CASE WHEN o.status IN ('accepted','dry_run') THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN me.event_type='delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN me.event_type='reply' THEN 1 ELSE 0 END) AS replied,
           SUM(CASE WHEN me.event_type='hard_bounce' THEN 1 ELSE 0 END) AS bounced,
           SUM(CASE WHEN me.event_type='unsubscribe' THEN 1 ELSE 0 END) AS unsubscribed
    FROM campaigns camp
    LEFT JOIN enrollments e ON e.campaign_id = camp.id
    LEFT JOIN outbox o ON o.enrollment_id = e.id
    LEFT JOIN message_events me ON me.outbox_id = o.id
    GROUP BY camp.id`);
  return json({ campaigns: rows });
}

async function analyticsAi(env) {
  const [byProvider, byOperation, failures, cost] = await Promise.all([
    all(env.DB, "SELECT provider,COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens FROM ai_usage GROUP BY provider"),
    all(env.DB, "SELECT operation,COUNT(*) AS calls FROM ai_usage GROUP BY operation"),
    one(env.DB, "SELECT COUNT(*) AS count FROM ai_usage WHERE status='failure'"),
    one(env.DB, "SELECT SUM(estimated_cost) AS total FROM ai_usage")
  ]);
  const total = await one(env.DB, "SELECT COUNT(*) AS count FROM ai_usage");
  return json({ total_calls: total.count, failure_rate: total.count ? failures.count / total.count : 0, estimated_cost_usd: cost.total || 0, by_provider: byProvider, by_operation: byOperation });
}

async function analyticsProviders(env) {
  const sources = await all(env.DB, "SELECT name,provider_type,enabled,last_run_at,last_error FROM discovery_sources");
  const ai = await all(env.DB, "SELECT provider,status,COUNT(*) AS count FROM ai_usage GROUP BY provider,status");
  return json({ discovery_sources: sources, ai_providers: ai });
}

// --- Notification preferences (spec §25) --------------------------------------------
async function getNotificationPreferences(env) { return json({ preferences: await all(env.DB, "SELECT * FROM notification_preferences") }); }

async function putNotificationPreferences(request, env) {
  const data = await readJson(request);
  if (!data.event_type) return error("event_type is required");
  const timestamp = nowIso();
  await run(env.DB, `INSERT INTO notification_preferences (event_type,dashboard,slack,discord,email,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(event_type) DO UPDATE SET dashboard=excluded.dashboard,slack=excluded.slack,discord=excluded.discord,email=excluded.email,updated_at=excluded.updated_at`,
    data.event_type, data.dashboard === false ? 0 : 1, data.slack ? 1 : 0, data.discord ? 1 : 0, data.email ? 1 : 0, timestamp);
  return json({ preference: await one(env.DB, "SELECT * FROM notification_preferences WHERE event_type=?", data.event_type) });
}

async function route(request, env) {
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  if (method === "GET" && path === "/health") return json({ ok: true, send_mode: env.SEND_MODE || "dry_run" });
  if (method === "POST" && path === "/api/provider-events") return providerEvent(request, env);
  if (!path.startsWith("/api/")) return new Response("Argmax Outreach API", { status: 200 });
  requireAdmin(request, env);
  if (method === "GET" && path === "/api/dashboard") return dashboard(env);
  if (method === "GET" && path === "/api/reports/daily") return dailyReport(env);
  if (method === "GET" && path === "/api/companies") return listCompanies(env, url);
  const companyDetailMatch = path.match(/^\/api\/companies\/([^/]+)$/);
  if (method === "GET" && companyDetailMatch) return companyDetail(env, companyDetailMatch[1]);
  if (method === "POST" && path === "/api/signals") return ingestSignal(request, env);
  if (method === "POST" && path === "/api/contacts") return createContact(request, env);
  const contactDiscover = path.match(/^\/api\/contacts\/discover\/([^/]+)$/);
  if (method === "POST" && contactDiscover) return triggerContactDiscovery(env, contactDiscover[1]);
  const contactVerify = path.match(/^\/api\/contacts\/([^/]+)\/verify$/);
  if (method === "POST" && contactVerify) return verifyContactEmail(env, contactVerify[1]);
  const companyEnrich = path.match(/^\/api\/enrichment\/([^/]+)$/);
  if (method === "POST" && companyEnrich) return triggerCompanyEnrichment(env, companyEnrich[1]);
  if (method === "POST" && path === "/api/qualifications") return qualify(request, env);
  if (method === "POST" && path === "/api/templates") return createTemplate(request, env);
  if (method === "POST" && path === "/api/campaigns") return createCampaign(request, env);
  const campaignStatus = path.match(/^\/api\/campaigns\/([^/]+)\/status$/);
  if (method === "POST" && campaignStatus) return setCampaignStatus(request, env, campaignStatus[1]);
  if (method === "POST" && path === "/api/enrollments") return createEnrollment(request, env);
  const approval = path.match(/^\/api\/enrollments\/([^/]+)\/approve$/);
  if (method === "POST" && approval) return approveEnrollment(request, env, approval[1]);
  if (method === "POST" && path === "/api/outbox") return scheduleOutbox(request, env);
  if (method === "POST" && path === "/api/dispatch-due") return json({ enqueued: await enqueueDue(env) });
  if (method === "POST" && path === "/api/discovery/run") return json(await runDiscovery(env));
  if (method === "GET" && path === "/api/discovery/sources") return listDiscoverySources(env);
  const sourceToggle = path.match(/^\/api\/discovery\/sources\/([^/]+)$/);
  if (method === "POST" && sourceToggle) return toggleDiscoverySource(request, env, sourceToggle[1]);
  if (method === "GET" && path === "/api/discovery/runs") return listDiscoveryRuns(env);
  const leadResearch = path.match(/^\/api\/leads\/([^/]+)\/research$/);
  if (method === "POST" && leadResearch) return triggerResearch(env, leadResearch[1]);
  const leadEmail = path.match(/^\/api\/leads\/([^/]+)\/generate-email$/);
  if (method === "POST" && leadEmail) { const body = await readJson(request).catch(() => ({})); return generateEmail(env, leadEmail[1], body.contact_id); }
  const leadDrafts = path.match(/^\/api\/leads\/([^/]+)\/drafts$/);
  if (method === "GET" && leadDrafts) return listEmailDrafts(env, leadDrafts[1]);
  if (method === "GET" && path === "/api/notifications") return listNotifications(env, url);
  const notificationRead = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (method === "POST" && notificationRead) return markNotificationRead(env, notificationRead[1]);
  if (method === "GET" && path === "/api/activity") return listActivity(env);
  if (method === "GET" && path === "/api/notification-preferences") return getNotificationPreferences(env);
  if (method === "PUT" && path === "/api/notification-preferences") return putNotificationPreferences(request, env);
  if (method === "GET" && path === "/api/export/companies.csv") return exportCompaniesCsv(env);
  if (method === "GET" && path === "/api/export/leads.csv") return exportLeadsCsv(env);
  if (method === "GET" && path === "/api/export/leads.xlsx") return exportLeadsXlsx(env);
  if (method === "GET" && path === "/api/export/contacts.csv") return exportContactsCsv(env);
  if (method === "GET" && path === "/api/export/outreach.csv") return exportOutreachCsv(env);
  if (method === "GET" && path === "/api/analytics/overview") return analyticsOverview(env);
  if (method === "GET" && path === "/api/analytics/funnel") return analyticsFunnel(env);
  if (method === "GET" && path === "/api/analytics/sources") return analyticsSources(env);
  if (method === "GET" && path === "/api/analytics/campaigns") return analyticsCampaigns(env);
  if (method === "GET" && path === "/api/analytics/ai") return analyticsAi(env);
  if (method === "GET" && path === "/api/analytics/providers") return analyticsProviders(env);
  return error("Not found", 404);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (cause) { if (cause instanceof Response) return cause; console.error(cause); return error(cause.message || "Internal error", 500); }
  },
  async scheduled(_, env, ctx) { ctx.waitUntil(Promise.all([runDiscovery(env), enqueueDue(env)])); },
  async queue(batch, env) { for (const message of batch.messages) { const result = await dispatchOutbox(env, message.body.outbox_id); if (result.status === "send_unknown") message.retry(); else message.ack(); } }
};