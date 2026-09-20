import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* not available on this Node version */ }

/**
 * Exercises the AI provider chain, claim-validation gate, CSV/XLSX export, and
 * Slack notification dispatch end to end against a real in-memory SQLite
 * database, with only `fetch()` mocked (Gemini's API, Groq's API, and the Slack
 * webhook). Requires Node >= 22.5 for node:sqlite; skipped otherwise.
 */
test("AI research + personalization + claim validation + export + Slack dispatch", { skip: !DatabaseSync }, async () => {
  const { makeD1 } = await import("./d1-shim.js");
  const worker = (await import("../src/index.js")).default;

  const db = makeD1(path.join(dir, "..", "schema.sql"));
  const env = {
    DB: db, ADMIN_TOKEN: "test-admin", WEBHOOK_SECRET: "test-webhook", DISCOVERY_ENABLED: "false",
    SEND_MODE: "dry_run", HIGH_VALUE_LEAD_THRESHOLD: "10", LEAD_QUALIFICATION_THRESHOLD: "10",
    AI_PRIMARY_PROVIDER: "gemini", AI_PRIMARY_MODEL: "gemini-test", GEMINI_API_KEY: "test-key",
    AI_FALLBACK_PROVIDER: "groq", AI_FALLBACK_MODEL: "groq-test", GROQ_API_KEY: "test-key",
    SLACK_ENABLED: "true", SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/xyz"
  };

  const timestamp = new Date().toISOString();
  await env.DB.prepare("INSERT INTO companies (id,name,domain,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind("co_1", "Acme AI", "acme-ai.test", "researching", timestamp, timestamp).run();
  await env.DB.prepare("INSERT INTO contacts (id,company_id,email,first_name,title,verification_status,contact_basis,policy_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind("ct_1", "co_1", "jane@acme-ai.test", "Jane", "CTO", "valid", "website_public_page", "eligible", timestamp, timestamp).run();
  await env.DB.prepare("INSERT INTO signals (id,company_id,source_url,source_name,source_key,title,summary,event_type,retrieved_at,evidence_excerpt,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind("sig_1", "co_1", "https://news.test/a", "test", "sig:1", "Acme AI raises $4M seed", "Acme AI raised $4M.", "funding", timestamp, "Acme AI raised $4M seed led by Test Ventures.", "corroborated", timestamp).run();

  let slackCalls = 0; let geminiCalls = 0;
  const geminiResearchBody = { candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "Acme AI is an AI backend startup that recently raised a $4M seed round.", business_model: "B2B SaaS", products: ["API platform"], likely_needs: ["backend scaling"], technology_signals: [], growth_signals: ["funding"], reasons_argmax_may_help: ["Recently funded and likely to scale engineering"], evidence: [] }) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 90 } };
  const geminiPersonalizationBody = { candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: "Helping Acme AI scale after your $4M seed", body: "Hi Jane, congrats on the $4M seed round -- happy to help with backend scaling.", personalization_points: ["$4M seed round"], claims_used: ["Acme AI raised $4M seed"] }) }] } }] };
  const geminiValidationBody = { candidates: [{ content: { parts: [{ text: JSON.stringify({ valid: true, claims: [{ claim: "Acme AI raised a $4M seed round", status: "SUPPORTED", source: "https://news.test/a" }] }) }] } }] };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      const body = JSON.parse(init.body);
      const userText = body.contents[0].parts[0].text;
      if (userText.includes("Email body:")) return new Response(JSON.stringify(geminiValidationBody), { status: 200 });
      if (userText.includes("Contact:")) return new Response(JSON.stringify(geminiPersonalizationBody), { status: 200 });
      return new Response(JSON.stringify(geminiResearchBody), { status: 200 });
    }
    if (href.includes("hooks.slack.test")) { slackCalls += 1; return new Response("ok", { status: 200 }); }
    if (href.includes("acme-ai.test")) return new Response("<html><body>no contacts here</body></html>", { status: 200 });
    return new Response("{}", { status: 200 });
  };

  try {
    const auth = { authorization: "Bearer test-admin", "content-type": "application/json" };

    // Opt NEW_HIGH_VALUE_LEAD into Slack via the preferences endpoint -- channels
    // are opt-in per event type (spec §25), so this must be set before it fires.
    const prefResponse = await worker.fetch(new Request("https://worker.test/api/notification-preferences", { method: "PUT", headers: auth, body: JSON.stringify({ event_type: "NEW_HIGH_VALUE_LEAD", dashboard: true, slack: true }) }), env);
    assert.equal(prefResponse.status, 200);

    // 1. Research should call the real (mocked) Gemini provider and merge its
    //    structured output in, and cross the low threshold -> Slack dispatch.
    const researchResponse = await worker.fetch(new Request("https://worker.test/api/leads/co_1/research", { method: "POST", headers: auth }), env);
    assert.equal(researchResponse.status, 200);
    const research = await researchResponse.json();
    assert.ok(geminiCalls >= 1, "Gemini should have been called for research");
    assert.match(research.ai_research.summary, /\$4M seed/);
    assert.equal(research.ai_meta.provider, "gemini");
    assert.ok(research.notification, "high-value notification should fire");
    assert.ok(slackCalls >= 1, "Slack webhook should have been dispatched for the high-value notification");

    const usage = await env.DB.prepare("SELECT * FROM ai_usage WHERE operation='research'").all();
    assert.ok(usage.results.length >= 1);
    assert.equal(usage.results[0].status, "success");
    assert.equal(usage.results[0].provider, "gemini");

    // 2. Personalization + claim validation: SUPPORTED claim -> draft marked valid.
    const emailResponse = await worker.fetch(new Request("https://worker.test/api/leads/co_1/generate-email", { method: "POST", headers: auth, body: "{}" }), env);
    assert.equal(emailResponse.status, 200);
    const draft = await emailResponse.json();
    assert.match(draft.subject, /Acme AI/);
    assert.equal(draft.validation.valid, true);

    const drafts = await (await worker.fetch(new Request("https://worker.test/api/leads/co_1/drafts", { headers: auth }), env)).json();
    assert.equal(drafts.drafts.length, 1);
    assert.equal(drafts.drafts[0].valid, 1);

    // 3. Now force an UNSUPPORTED claim and confirm the draft is stored but marked invalid.
    const unsupportedValidation = { candidates: [{ content: { parts: [{ text: JSON.stringify({ valid: false, claims: [{ claim: "Acme AI uses Kubernetes", status: "UNSUPPORTED", source: null }] }) }] } }] };
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes("generativelanguage.googleapis.com")) {
        const body = JSON.parse(init.body);
        const userText = body.contents[0].parts[0].text;
        if (userText.includes("Email body:")) return new Response(JSON.stringify(unsupportedValidation), { status: 200 });
        return new Response(JSON.stringify(geminiPersonalizationBody), { status: 200 });
      }
      if (href.includes("hooks.slack.test")) return new Response("ok", { status: 200 });
      return new Response("{}", { status: 200 });
    };
    const blockedResponse = await worker.fetch(new Request("https://worker.test/api/leads/co_1/generate-email", { method: "POST", headers: auth, body: "{}" }), env);
    const blocked = await blockedResponse.json();
    assert.equal(blocked.validation.valid, false);
    assert.equal(blocked.validation.blocking[0].status, "UNSUPPORTED");

    // 4. Exports: CSV should list the company/contact; XLSX should be a real workbook.
    const csvResponse = await worker.fetch(new Request("https://worker.test/api/export/leads.csv", { headers: auth }), env);
    const csvText = await csvResponse.text();
    assert.match(csvText, /Acme AI/); assert.match(csvText, /jane@acme-ai\.test/);

    const xlsxResponse = await worker.fetch(new Request("https://worker.test/api/export/leads.xlsx", { headers: auth }), env);
    const xlsxBytes = new Uint8Array(await xlsxResponse.arrayBuffer());
    assert.equal(xlsxResponse.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(xlsxBytes[0], 0x50); assert.equal(xlsxBytes[1], 0x4b); // PK zip magic

    // 5. Analytics endpoints should reflect the AI usage and funnel state.
    const aiAnalytics = await (await worker.fetch(new Request("https://worker.test/api/analytics/ai", { headers: auth }), env)).json();
    assert.ok(aiAnalytics.total_calls >= 3); // research + personalization + validation, x2 for the second draft
    assert.ok(aiAnalytics.by_provider.some((p) => p.provider === "gemini"));

    const funnel = await (await worker.fetch(new Request("https://worker.test/api/analytics/funnel", { headers: auth }), env)).json();
    assert.equal(funnel.stages.discovered, 1);
    assert.equal(funnel.stages.research_completed, 1);
    assert.equal(funnel.stages.email_drafted, 1); // distinct company_id, not distinct draft rows

    // 6. Email verification via DNS-over-HTTPS (mocked) should advance the state machine.
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("cloudflare-dns.com") && href.includes("type=MX")) return new Response(JSON.stringify({ Answer: [{ type: 15, data: "10 mail.acme-ai.test" }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    await env.DB.prepare("UPDATE contacts SET verification_status='unknown' WHERE id=?").bind("ct_1").run();
    const verifyResponse = await worker.fetch(new Request("https://worker.test/api/contacts/ct_1/verify", { method: "POST", headers: auth }), env);
    const verifyResult = await verifyResponse.json();
    assert.equal(verifyResult.status, "valid");
    assert.equal(verifyResult.verification_status, "valid");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
