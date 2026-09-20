import {
  classifyEmailVerification, extractMailtoContacts, generateEmailCandidates,
  domainNameSimilarity, isBlockedResolutionDomain, withinBudget, normalizeDomain, id, nowIso
} from "./core.js";

const DISPOSABLE_DOMAINS = new Set(["mailinator.com", "tempmail.com", "guerrillamail.com", "10minutemail.com", "yopmail.com", "trashmail.com", "throwawaymail.com"]);
const UA = { "user-agent": "ArgmaxOutreachResearch/0.1 (+https://argmax.one)" };

/**
 * Free CompanyEnrichmentProvider: pulls a company's own homepage and extracts
 * only what the page explicitly states via conservative regexes (an "N
 * employees" mention, obvious technology mentions in visible text). It never
 * infers or estimates -- anything not explicitly found stays undefined, which
 * callers must render as UNKNOWN, not guess at. `ENRICHMENT_API_URL` remains
 * the adapter point for a paid provider (Clearbit/Apollo/etc.); this function
 * is what runs when no paid provider is configured, so the MVP never requires
 * a paid dependency (spec §19).
 */
export async function enrichCompanyFromWebsite(company) {
  const sourceUrls = [];
  let html = "";
  try {
    const pageUrl = `https://${company.domain}`;
    const response = await fetch(pageUrl, { headers: { "user-agent": "ArgmaxOutreachResearch/0.1 (+https://argmax.one)" } });
    if (response.ok) { html = (await response.text()).slice(0, 2_000_000); sourceUrls.push(pageUrl); }
  } catch { /* best-effort only */ }
  if (!html) return { sourceUrls };
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const employeeMatch = text.match(/\b(\d{1,5})\+?\s+employees\b/i);
  const KNOWN_TECH = ["React", "Vue", "Angular", "Kubernetes", "Docker", "AWS", "Google Cloud", "Azure", "Python", "TypeScript", "Go", "Rust", "GraphQL", "PostgreSQL", "Next.js"];
  const technologies = KNOWN_TECH.filter((tech) => new RegExp(`\\b${tech.replace(/[.+]/g, "\\$&")}\\b`, "i").test(text));
  return {
    employeeCount: employeeMatch ? Number(employeeMatch[1]) : undefined,
    technologies: technologies.length ? technologies : undefined,
    sourceUrls
  };
}

/**
 * Free ContactProvider: extracts mailto: links the company's own site published.
 * Wraps the same extraction used during discovery so both call sites share one
 * implementation. Never guesses an address. `CONTACT_PROVIDER_API_URL` is the
 * adapter point for a paid contact-discovery provider.
 */
export async function findContactsFromWebsite(company) {
  try {
    const pageUrl = `https://${company.domain}`;
    const response = await fetch(pageUrl, { headers: { "user-agent": "ArgmaxOutreachResearch/0.1 (+https://argmax.one)" } });
    if (!response.ok) return [];
    const html = (await response.text()).slice(0, 2_000_000);
    return extractMailtoContacts(html).map((c) => ({ email: c.email, title: c.label, source: "website", sourceUrl: pageUrl, confidence: 0.4 }));
  } catch { return []; }
}

/**
 * Free EmailVerificationProvider using DNS-over-HTTPS (Cloudflare's public
 * resolver, no API key needed) to check whether the email's domain actually
 * publishes mail-exchange records. This verifies deliverability at the domain
 * level -- real signal, not just string shape -- but is weaker than a paid
 * mailbox-ping verifier (ZeroBounce, NeverBounce, etc.), which remains the
 * adapter point behind `EMAIL_VERIFICATION_API_URL` for anyone who configures one.
 */
export async function verifyEmailViaDns(email) {
  const domain = email?.split("@")[1]?.toLowerCase();
  if (!domain) return { email, status: classifyEmailVerification({ email, hasMx: false, hasA: false }), provider: "dns_mx_lookup", checkedAt: new Date().toISOString() };
  const isDisposableDomain = DISPOSABLE_DOMAINS.has(domain);
  let hasMx = false; let hasA = false;
  try {
    const mxResponse = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: "application/dns-json" } });
    if (mxResponse.ok) { const payload = await mxResponse.json(); hasMx = Array.isArray(payload.Answer) && payload.Answer.some((a) => a.type === 15); }
  } catch { /* treated as no MX found */ }
  if (!hasMx) {
    try {
      const aResponse = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, { headers: { accept: "application/dns-json" } });
      if (aResponse.ok) { const payload = await aResponse.json(); hasA = Array.isArray(payload.Answer) && payload.Answer.some((a) => a.type === 1); }
    } catch { /* treated as no A record found */ }
  }
  const status = classifyEmailVerification({ email, hasMx, hasA, isDisposableDomain });
  return { email, status, confidence: status === "valid" ? 0.7 : status === "risky" ? 0.4 : 0.1, provider: "dns_mx_lookup", checkedAt: new Date().toISOString() };
}

/**
 * If `SMTP_VERIFY_API_URL` is configured, calls out to a real SMTP-level
 * verifier (for example, the person's own Reacher/startup-tracker deployment --
 * see startup-tracker/main.py's new /api/verify-email endpoint in this
 * delivery) over plain HTTPS. Cloudflare Workers cannot do this verification
 * themselves: the Workers runtime blocks outbound TCP connections on port 25
 * by default (https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/,
 * "Considerations"), so a real RCPT-TO handshake has to happen somewhere that
 * isn't a Worker. This is the adapter point for that -- point it at any HTTP
 * service that accepts {"email": "..."} and returns {"status": "valid|invalid|catch_all|unknown", "detail": "..."}.
 * Returns null (not a guess) if unconfigured or unreachable, so callers fall
 * back to the free DNS-only check instead of pretending this ran.
 */
export async function verifyEmailViaExternalSmtpService(env, email) {
  if (!env.SMTP_VERIFY_API_URL) return null;
  try {
    const response = await fetch(env.SMTP_VERIFY_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.SMTP_VERIFY_API_KEY ? { authorization: `Bearer ${env.SMTP_VERIFY_API_KEY}` } : {}) },
      body: JSON.stringify({ email })
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || typeof payload.status !== "string") return null;
    // Map the verifier's own vocabulary (valid/invalid/catch_all/unknown/guessed/not_found)
    // onto this system's states; anything it can't confirm falls back to "risky"
    // rather than being silently treated as good.
    const mapped = { valid: "valid", invalid: "invalid", catch_all: "risky", guessed: "risky", unknown: "risky", not_found: "invalid" }[payload.status] || "risky";
    return { email, status: mapped, confidence: mapped === "valid" ? 0.95 : mapped === "invalid" ? 0.9 : 0.3, provider: "external_smtp_verifier", detail: payload.detail || null, checkedAt: new Date().toISOString() };
  } catch (cause) { console.error("external SMTP verifier request failed", cause.message); return null; }
}

/**
 * Persistent, D1-backed monthly credit budget for a free-tier provider, reusing
 * the existing usage_ledger table (usage_type='enrichment_credit') instead of
 * adding a new table. Mirrors rate_limit.py's CreditBudget: spend() reserves
 * credits and returns false (spending nothing) if that would go over budget.
 */
async function spendBudget(env, provider, monthlyLimit, amount = 1) {
  if (!env.DB || monthlyLimit <= 0) return false;
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const spent = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM usage_ledger WHERE provider=? AND usage_type='enrichment_credit' AND occurred_at>=?")
    .bind(provider, monthStart.toISOString()).first();
  if (!withinBudget(spent?.total || 0, amount, monthlyLimit)) return false;
  await env.DB.prepare("INSERT INTO usage_ledger (id,provider,usage_type,amount,occurred_at,notes) VALUES (?,?,?,?,?,?)")
    .bind(id("usage"), provider, "enrichment_credit", amount, nowIso(), "free-tier credit spend").run();
  return true;
}

/**
 * Free, no-key company-name -> domain resolver, ported from domain_resolver.py:
 * 1. Clearbit's old autocomplete endpoint (soft-fails; reportedly sunset since
 *    Clearbit folded into HubSpot, kept as a first free attempt).
 * 2. DuckDuckGo's HTML search results (no key, no signup), filtered against a
 *    blocklist of aggregator/news/social domains and scored by name similarity.
 * A result is only accepted once it has a real MX or A record (verifyEmailViaDns's
 * DNS check, reused here at the domain level), so a resolved domain is at
 * least confirmed to exist and accept some form of traffic before it's used to
 * create a company or attempt contact discovery.
 */
export async function resolveDomainFromCompanyName(companyName) {
  try {
    const response = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(companyName)}`, { headers: UA });
    if (response.ok) {
      const results = await response.json();
      for (const item of (Array.isArray(results) ? results : []).slice(0, 3)) {
        const domain = normalizeDomain(item?.domain);
        if (domain && !isBlockedResolutionDomain(domain) && domainNameSimilarity(companyName, domain) >= 0.7 && await domainHasMxOrA(domain)) {
          return { domain, source: "clearbit_autocomplete" };
        }
      }
    }
  } catch { /* Clearbit endpoint may be gone; DuckDuckGo below is the real fallback */ }

  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${companyName}" official website`)}`, { headers: UA });
    if (response.ok) {
      const html = await response.text();
      for (const domain of extractResultDomains(html)) {
        const clean = normalizeDomain(domain);
        if (clean && !isBlockedResolutionDomain(clean) && domainNameSimilarity(companyName, clean) >= 0.6 && await domainHasMxOrA(clean)) {
          return { domain: clean, source: "duckduckgo" };
        }
      }
    }
  } catch (cause) { console.error("DuckDuckGo domain resolution failed", cause.message); }

  return { domain: null, source: null };
}

/** Extracts outbound result URLs' hostnames from a DuckDuckGo HTML results page. */
function extractResultDomains(html) {
  const domains = [];
  const re = /class="result__a"[^>]*href="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) && domains.length < 8) {
    try {
      let target = decodeURIComponent(match[1]);
      const uddgMatch = target.match(/[?&]uddg=([^&]+)/); // DuckDuckGo wraps result URLs in a redirect param
      if (uddgMatch) target = decodeURIComponent(uddgMatch[1]);
      domains.push(new URL(target).hostname);
    } catch { /* skip unparseable result */ }
  }
  return domains;
}

async function domainHasMxOrA(domain) {
  const result = await verifyEmailViaDns(`postmaster@${domain}`);
  return result.status === "valid" || result.status === "risky";
}

/**
 * Free-tier Hunter.io adapter (domain-search + email-finder), enabled only
 * when HUNTER_API_KEY is set, and self-throttled against HUNTER_MONTHLY_BUDGET
 * (default matches Hunter's own free-plan ceiling) via spendBudget so it can
 * never silently exceed the free tier. Mirrors hunter_client.py.
 */
export async function hunterDomainSearch(env, domain) {
  if (!env.HUNTER_API_KEY) return [];
  if (!(await spendBudget(env, "hunter", Number(env.HUNTER_MONTHLY_BUDGET ?? 45)))) return [];
  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&type=personal&seniority=senior,executive&api_key=${env.HUNTER_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload?.data?.emails || []).filter((e) => e.value && e.first_name).map((e) => ({
      email: e.value, firstName: e.first_name, lastName: e.last_name || "", title: e.position || null,
      confidence: e.confidence != null ? e.confidence / 100 : null, source: "hunter_domain_search"
    }));
  } catch (cause) { console.error("Hunter domain-search failed", cause.message); return []; }
}

/** Free-tier Apollo.io adapter (people search only -- match_person, which reveals emails, spends a credit and is intentionally not wired by default; see README). */
export async function apolloSearchPeople(env, domain) {
  if (!env.APOLLO_API_KEY) return [];
  try {
    const response = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.APOLLO_API_KEY },
      body: JSON.stringify({ q_organization_domains_list: [domain], person_titles: ["CEO", "Founder", "Co-Founder", "CTO", "COO"], page: 1, per_page: 3 })
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload?.people || []).filter((p) => p.first_name).map((p) => ({
      firstName: p.first_name, lastName: p.last_name || p.last_name_obfuscated || "", title: p.title || null,
      email: p.email && !String(p.email).includes("email_not_unlocked") ? p.email : null, source: "apollo_people_search"
    }));
  } catch (cause) { console.error("Apollo people search failed", cause.message); return []; }
}

/**
 * Full free-tier-first contact discovery: tries the company's own website
 * (always free, no key), then Hunter if configured, then Apollo people-search
 * (names only -- rarely emails on the free plan) if configured, and only as a
 * last resort falls back to generating likely addresses (spec: this NEVER
 * marks a guess as verified -- see the contact_basis/verification_status this
 * sets). Returns as soon as a step finds something, so a fully free setup
 * (no Hunter/Apollo keys) never calls anything paid.
 */
export async function discoverContactsFreeTierFirst(env, company) {
  const website = await findContactsFromWebsite(company);
  if (website.length) return { contacts: website, source: "website" };

  const hunterResults = await hunterDomainSearch(env, company.domain);
  if (hunterResults.length) return {
    contacts: hunterResults.map((r) => ({ email: r.email, firstName: r.firstName, lastName: r.lastName, title: r.title, source: "hunter", confidence: r.confidence ?? 0.5 })),
    source: "hunter"
  };

  const apolloResults = await apolloSearchPeople(env, company.domain);
  const apolloWithEmail = apolloResults.filter((p) => p.email);
  if (apolloWithEmail.length) return { contacts: apolloWithEmail.map((p) => ({ email: p.email, firstName: p.firstName, lastName: p.lastName, title: p.title, source: "apollo", confidence: 0.6 })), source: "apollo" };

  // Last resort: we have named people (from Apollo's free people-search, which
  // returns names without emails on the free plan) but no confirmed address.
  // Generate candidates and keep only ones whose domain resolves at all -- this
  // is a GUESS, and is surfaced as such (source="permutation_guess",
  // never a verification_status beyond "pending") for the caller to decide
  // whether to pursue further via a real SMTP check.
  if (apolloResults.length) {
    const guesses = [];
    for (const person of apolloResults.slice(0, 2)) {
      const candidates = generateEmailCandidates(person.firstName, person.lastName, company.domain);
      if (candidates.length) guesses.push({ email: candidates[0], firstName: person.firstName, lastName: person.lastName, title: person.title, source: "permutation_guess", confidence: 0.15, allCandidates: candidates });
    }
    if (guesses.length) return { contacts: guesses, source: "permutation_guess" };
  }
  return { contacts: [], source: "none" };
}