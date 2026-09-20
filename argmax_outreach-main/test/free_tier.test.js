import test from "node:test";
import assert from "node:assert/strict";
import {
  withinBudget, generateEmailCandidates, genericEmailCandidates, domainNameSimilarity,
  isBlockedResolutionDomain, truncateToTokenBudget
} from "../src/core.js";

test("withinBudget is a strict, inclusive comparison against the monthly limit", () => {
  assert.equal(withinBudget(0, 1, 50), true);
  assert.equal(withinBudget(49, 1, 50), true);
  assert.equal(withinBudget(50, 1, 50), false);
  assert.equal(withinBudget(0, 51, 50), false);
});

test("generateEmailCandidates produces common startup patterns and never invents a domain", () => {
  const candidates = generateEmailCandidates("Jane", "Doe", "https://www.example.ai/");
  assert.deepEqual(candidates, [
    "jane.doe@example.ai", "jane@example.ai", "jdoe@example.ai", "janedoe@example.ai", "janed@example.ai",
    "j.doe@example.ai", "jane_doe@example.ai", "doe@example.ai", "doe.jane@example.ai", "jane-doe@example.ai"
  ]);
  assert.deepEqual(generateEmailCandidates("", "Doe", "example.com"), []);
  assert.deepEqual(generateEmailCandidates("Jane", "Doe", "not a domain"), []);
  // Accented characters are normalized the same way email_permutator.py does.
  assert.deepEqual(generateEmailCandidates("José", "Núñez", "example.com").slice(0, 2), ["jose.nunez@example.com", "jose@example.com"]);
});

test("genericEmailCandidates produces the standard role-inbox set for a domain", () => {
  const candidates = genericEmailCandidates("example.com");
  assert.ok(candidates.includes("ceo@example.com"));
  assert.ok(candidates.includes("hello@example.com"));
  assert.equal(genericEmailCandidates("not a domain").length, 0);
});

test("domainNameSimilarity scores an exact/substring match as 1 and unrelated names near 0", () => {
  assert.equal(domainNameSimilarity("Acme AI", "acmeai.com"), 1);
  assert.equal(domainNameSimilarity("Acme AI", "acme.com"), 1); // substring match either direction
  assert.ok(domainNameSimilarity("Acme AI", "totallyunrelated.com") < 0.3);
  assert.equal(domainNameSimilarity("", "example.com"), 0);
  assert.equal(domainNameSimilarity("Acme AI", "not a domain"), 0);
});

test("isBlockedResolutionDomain rejects aggregator/social/news domains, not real companies", () => {
  assert.equal(isBlockedResolutionDomain("linkedin.com"), true);
  assert.equal(isBlockedResolutionDomain("techcrunch.com"), true);
  assert.equal(isBlockedResolutionDomain("news.techcrunch.com"), true); // subdomain of a blocked domain
  assert.equal(isBlockedResolutionDomain("acme-ai.com"), false);
  assert.equal(isBlockedResolutionDomain(""), true);
});

test("truncateToTokenBudget keeps short text untouched and trims long text with a visible marker", () => {
  const short = "hello world";
  assert.equal(truncateToTokenBudget(short, 100), short);
  const long = "x".repeat(10000);
  const truncated = truncateToTokenBudget(long, 100); // ~400 chars
  assert.ok(truncated.length < long.length);
  assert.match(truncated, /truncated to stay within/);
});
