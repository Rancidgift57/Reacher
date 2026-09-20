import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* not available on this Node version */ }

test("free domain resolution + Hunter contact discovery with budget enforcement + external SMTP verifier", { skip: !DatabaseSync }, async () => {
  const { makeD1 } = await import("./d1-shim.js");
  const worker = (await import("../src/index.js")).default;

  const db = makeD1(path.join(dir, "..", "schema.sql"));
  const env = {
    DB: db, ADMIN_TOKEN: "test-admin", WEBHOOK_SECRET: "test-webhook", DISCOVERY_ENABLED: "true", YC_ENABLED: "false",
    SEND_MODE: "dry_run", HUNTER_API_KEY: "test-hunter-key", HUNTER_MONTHLY_BUDGET: "2",
    SMTP_VERIFY_API_URL: "https://reacher.example.com/api/verify-email"
  };

  const rssBody = `<?xml version="1.0"?><rss><channel>
    <item><title>Example Robotics raises $6M seed</title><link>https://news.test/example-robotics</link><description>Example Robotics raised a $6M seed round.</description></item>
  </channel></rss>`;
  let hunterCalls = 0;
  let smtpCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("news.google.com") || href.includes("techcrunch.com") || href.includes("eu-startups.com") || href.includes("rss/search")) return new Response(rssBody, { status: 200 });
    if (href.includes("autocomplete.clearbit.com")) return new Response("[]", { status: 200 }); // soft-fails, forcing the DuckDuckGo path
    if (href.includes("html.duckduckgo.com")) {
      return new Response('<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample-robotics.test%2F">Example Robotics</a>', { status: 200 });
    }
    if (href.includes("cloudflare-dns.com") && href.includes("type=MX")) return new Response(JSON.stringify({ Answer: [{ type: 15, data: "10 mail.example-robotics.test" }] }), { status: 200 });
    if (href.includes("api.hunter.io")) {
      hunterCalls += 1;
      return new Response(JSON.stringify({ data: { emails: [{ value: "founder@example-robotics.test", first_name: "Ada", last_name: "Lovelace", position: "Founder", confidence: 80 }] } }), { status: 200 });
    }
    if (href.startsWith("https://example-robotics.test")) return new Response("<html><body>no mailto links here</body></html>", { status: 200 });
    if (href.includes("reacher.example.com")) { smtpCalls += 1; return new Response(JSON.stringify({ status: "valid", detail: "250 OK" }), { status: 200 }); }
    return new Response("{}", { status: 200 });
  };

  try {
    const auth = { authorization: "Bearer test-admin", "content-type": "application/json" };

    // 1. Discovery with NO paid ENRICHMENT_API_URL configured should still turn
    //    the RSS headline into a real company via free domain resolution.
    const discoveryResponse = await worker.fetch(new Request("https://worker.test/api/discovery/run", { method: "POST", headers: auth }), env);
    const discoveryResult = await discoveryResponse.json();
    assert.equal(discoveryResult.enrichment, "free_domain_resolution");
    assert.ok(discoveryResult.enriched >= 1, "the free domain-resolution path should have enriched at least one candidate");

    const { companies } = await (await worker.fetch(new Request("https://worker.test/api/companies", { headers: auth }), env)).json();
    const company = companies.find((c) => c.domain === "example-robotics.test");
    assert.ok(company, "Example Robotics should have been created via free domain resolution");

    // 2. Its contact should have come from Hunter (no mailto links on the page),
    //    and Hunter should have been called exactly once thanks to the auto
    //    contact-discovery step already firing during enrichment.
    const detail = await (await worker.fetch(new Request(`https://worker.test/api/companies/${company.id}`, { headers: auth }), env)).json();
    assert.equal(detail.contacts.length, 1);
    assert.equal(detail.contacts[0].email, "founder@example-robotics.test");
    assert.equal(detail.contacts[0].contact_basis, "hunter");
    assert.equal(hunterCalls, 1);

    // 3. Hunter's budget (2/month) should block further spend once exhausted --
    //    call contact discovery again for a second, manually-inserted company to
    //    prove the budget is shared/persisted, not per-call.
    const timestamp = new Date().toISOString();
    await env.DB.prepare("INSERT INTO companies (id,name,domain,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind("co_x", "Other Co", "other-co.test", "researching", timestamp, timestamp).run();
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("api.hunter.io")) { hunterCalls += 1; return new Response(JSON.stringify({ data: { emails: [{ value: "x@other-co.test", first_name: "X", position: "CEO", confidence: 90 }] } }), { status: 200 }); }
      if (href.startsWith("https://other-co.test")) return new Response("<html><body>no contacts</body></html>", { status: 200 });
      return new Response("{}", { status: 200 });
    };
    await worker.fetch(new Request("https://worker.test/api/contacts/discover/co_x", { method: "POST", headers: auth }), env); // spends the 2nd credit
    await env.DB.prepare("DELETE FROM contacts WHERE company_id='co_x'").run();
    const secondAttempt = await (await worker.fetch(new Request("https://worker.test/api/contacts/discover/co_x", { method: "POST", headers: auth }), env)).json();
    assert.equal(secondAttempt.found, 0, "Hunter's monthly budget (2 credits) should be exhausted by now, so the 3rd call should find nothing from Hunter");

    // 4. Contact verification should prefer the external SMTP verifier (the
    //    person's own Reacher deployment) over the free DNS-only check.
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("reacher.example.com")) { smtpCalls += 1; return new Response(JSON.stringify({ status: "valid", detail: "250 2.1.5 OK" }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    };
    const verifyResponse = await worker.fetch(new Request(`https://worker.test/api/contacts/${detail.contacts[0].id}/verify`, { method: "POST", headers: auth }), env);
    const verifyResult = await verifyResponse.json();
    assert.equal(verifyResult.provider, "external_smtp_verifier");
    assert.equal(verifyResult.status, "valid");
    assert.equal(verifyResult.verification_status, "valid");
    assert.ok(smtpCalls >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
