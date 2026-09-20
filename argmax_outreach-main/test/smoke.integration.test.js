import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Full end-to-end smoke test of the Worker's fetch/route handling against a real
 * in-memory SQLite database created from the actual schema.sql (via node:sqlite,
 * available in Node >= 22.5). This exercises the whole discovery -> company ->
 * signal -> contact -> research -> notification -> dashboard path with only
 * `fetch()` mocked, so a SQL typo or wiring mistake in src/index.js fails here
 * even though it can't fail a pure-function unit test.
 *
 * This uses an experimental Node API and is skipped (not failed) on Node versions
 * that don't have it, so `npm test` stays green everywhere; run it explicitly with
 * `node --test test/smoke.integration.test.js` on Node >= 22.5 for full coverage.
 */
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* not available on this Node version */ }

test("end-to-end: YC discovery -> contact discovery -> research -> notification -> dashboard", { skip: !DatabaseSync }, async () => {
  const fs = await import("node:fs");
  const { makeD1 } = await import("./d1-shim.js");
  const worker = (await import("../src/index.js")).default;

  const db = makeD1(path.join(dir, "..", "schema.sql"));
  const env = {
    DB: db, ADMIN_TOKEN: "test-admin", WEBHOOK_SECRET: "test-webhook",
    DISCOVERY_ENABLED: "true", YC_ENABLED: "true", SEND_MODE: "dry_run", HIGH_VALUE_LEAD_THRESHOLD: "50"
  };

  const ycCompanies = [
    { id: 1, name: "Example AI", website: "https://example-ai.test", batch: "W26", industries: ["B2B"], one_liner: "AI backend for teams.", isHiring: true, team_size: 8, url: "https://www.ycombinator.com/companies/example-ai" },
    { id: 2, name: "Boring Logistics Co", website: "https://boringlogistics.test", batch: "W26", industries: ["Logistics"], one_liner: "Trucking dispatch software.", isHiring: false, team_size: 4, url: "https://www.ycombinator.com/companies/boring-logistics" }
  ];
  const contactHtml = `<html><body><a href="mailto:jane@example-ai.test">Jane Doe, Co-Founder &amp; CTO</a></body></html>`;
  const emptyRss = `<?xml version="1.0"?><rss><channel></channel></rss>`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("yc-oss.github.io")) return new Response(JSON.stringify(ycCompanies), { status: 200 });
    if (href.includes("example-ai.test")) return new Response(contactHtml, { status: 200 });
    if (href.includes("boringlogistics.test")) return new Response("<html><body>no contact info</body></html>", { status: 200 });
    return new Response(emptyRss, { status: 200 }); // the default RSS sources
  };

  try {
    const auth = { authorization: "Bearer test-admin", "content-type": "application/json" };

    // 1. Run discovery: should bootstrap sources, pull both YC companies, and
    //    best-effort discover Jane's public contact for the first one.
    const discoveryResponse = await worker.fetch(new Request("https://worker.test/api/discovery/run", { method: "POST", headers: auth }), env);
    assert.equal(discoveryResponse.status, 200);
    const discoveryResult = await discoveryResponse.json();
    assert.equal(discoveryResult.disabled, false);
    assert.ok(discoveryResult.yc.length >= 1);
    assert.equal(discoveryResult.yc[0].created, 2);

    const companiesResponse = await worker.fetch(new Request("https://worker.test/api/companies", { headers: auth }), env);
    const { companies } = await companiesResponse.json();
    assert.equal(companies.length, 2);
    const exampleAi = companies.find((c) => c.name === "Example AI");
    assert.ok(exampleAi, "Example AI should have been created from the YC feed");
    assert.equal(exampleAi.domain, "example-ai.test");

    // 2. Contact discovery should have picked up Jane's mailto link automatically,
    //    starting in "pending" verification, never "valid".
    const detailResponse = await worker.fetch(new Request(`https://worker.test/api/companies/${exampleAi.id}`, { headers: auth }), env);
    const detail = await detailResponse.json();
    assert.equal(detail.contacts.length, 1);
    assert.equal(detail.contacts[0].email, "jane@example-ai.test");
    assert.equal(detail.contacts[0].verification_status, "pending");
    assert.equal(detail.signals.some((s) => s.event_type === "yc_startup_directory"), true);

    // 3. Research should score the AI/hiring company higher than the plain logistics one,
    //    and cross the configured high-value threshold, producing a notification.
    const researchResponse = await worker.fetch(new Request(`https://worker.test/api/leads/${exampleAi.id}/research`, { method: "POST", headers: auth }), env);
    assert.equal(researchResponse.status, 200);
    const research = await researchResponse.json();
    assert.ok(research.score.total >= 50, `expected a high score, got ${research.score.total}`);
    assert.ok(research.notification, "a high-value lead notification should have been created");

    const boring = companies.find((c) => c.name === "Boring Logistics Co");
    const boringResearch = await (await worker.fetch(new Request(`https://worker.test/api/leads/${boring.id}/research`, { method: "POST", headers: auth }), env)).json();
    assert.ok(boringResearch.score.total < research.score.total, "the AI/hiring company should score higher than the plain logistics one");

    // 4. Notifications, activity feed, and dashboard should all reflect the run.
    const notifications = await (await worker.fetch(new Request("https://worker.test/api/notifications", { headers: auth }), env)).json();
    assert.ok(notifications.notifications.some((n) => n.type === "NEW_HIGH_VALUE_LEAD"));

    const activity = await (await worker.fetch(new Request("https://worker.test/api/activity", { headers: auth }), env)).json();
    assert.ok(activity.activity.some((a) => a.type === "COMPANY_DISCOVERED"));
    assert.ok(activity.activity.some((a) => a.type === "CONTACT_FOUND"));

    const dashboardResponse = await (await worker.fetch(new Request("https://worker.test/api/dashboard", { headers: auth }), env)).json();
    assert.equal(dashboardResponse.new_companies_today, 2);
    assert.ok(dashboardResponse.unread_notifications >= 1);

    const runs = await (await worker.fetch(new Request("https://worker.test/api/discovery/runs", { headers: auth }), env)).json();
    assert.ok(runs.runs.some((r) => r.provider === "ycombinator" && r.status === "completed"));

    // 5. Discovery sources can be listed and disabled.
    const sources = await (await worker.fetch(new Request("https://worker.test/api/discovery/sources", { headers: auth }), env)).json();
    const ycSource = sources.sources.find((s) => s.id === "ycombinator-directory");
    assert.ok(ycSource);
    const disableResponse = await worker.fetch(new Request(`https://worker.test/api/discovery/sources/${ycSource.id}`, { method: "POST", headers: auth, body: JSON.stringify({ enabled: false }) }), env);
    assert.equal((await disableResponse.json()).source.enabled, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
