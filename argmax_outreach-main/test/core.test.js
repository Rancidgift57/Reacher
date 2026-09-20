import test from "node:test";
import assert from "node:assert/strict";
import { canDispatch, extractFundingCandidate, qualificationDecision, renderTemplate, scoreQualification, safeUrl } from "../src/core.js";

const validContact = { id: "ct_1", email: "owner@example.com", verification_status: "valid", policy_status: "eligible" };
const qualifiedScore = { need: 20, fit: 18, stability: 17, timing: 12, access: 9, practicality: 9 };

test("qualification requires need, valid email, policy eligibility, and 75 points", () => {
  assert.deepEqual(qualificationDecision(qualifiedScore, validContact), { total: 85, status: "qualified", reason: null });
  assert.equal(qualificationDecision({ ...qualifiedScore, need: 14 }, validContact).reason, "need_score_below_gate");
  assert.equal(qualificationDecision(qualifiedScore, { ...validContact, policy_status: "hold" }).reason, "contact_policy_not_eligible");
  assert.throws(() => scoreQualification({ ...qualifiedScore, fit: 21 }), /Invalid fit/);
});

test("template rendering rejects missing and unapproved values", () => {
  const template = { subject: "Hi {{first_name}}", body: "{{verified_observation}}", required_fields_json: '["first_name","verified_observation"]' };
  assert.deepEqual(renderTemplate(template, { first_name: "Asha", verified_observation: "I saw your expansion." }), { subject: "Hi Asha", body: "I saw your expansion." });
  assert.throws(() => renderTemplate(template, { first_name: "Asha" }), /Missing required/);
  assert.throws(() => renderTemplate({ ...template, body: "{{invented_fact}}" }, { first_name: "Asha", verified_observation: "Evidence" }), /Unapproved/);
});

test("dispatch blocks suppression, stale reply sync, inactive campaigns, and quotas", () => {
  const context = {
    enrollment: { status: "scheduled" }, campaign: { status: "active", daily_limit: 10 }, contact: validContact,
    company: { id: "co_1", status: "qualified" }, outbox: { status: "pending", scheduled_for: "2026-09-14T08:00:00.000Z" },
    suppressions: [], sendMode: "dry_run", replySyncFresh: true, sentToday: 0, globalLimit: 10, now: "2026-09-14T09:00:00.000Z"
  };
  assert.equal(canDispatch(context), null);
  assert.equal(canDispatch({ ...context, replySyncFresh: false }), "reply_sync_stale");
  assert.equal(canDispatch({ ...context, suppressions: [{ email: validContact.email }] }), "suppressed");
  assert.equal(canDispatch({ ...context, sentToday: 10 }), "daily_limit_reached");
});

test("evidence URLs prohibit local addresses", () => {
  assert.equal(safeUrl("https://example.com/funding"), "https://example.com/funding");
  assert.throws(() => safeUrl("http://localhost/admin"), /Private/);
});

test("funding headline extraction is conservative", () => {
  assert.deepEqual(extractFundingCandidate("Acme Robotics raises $8M seed round"), { company_name: "Acme Robotics", event_type: "funding", confidence: 45 });
  assert.equal(extractFundingCandidate("Why funding markets are recovering").confidence, 0);
});
