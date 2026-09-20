import { classifyAIFailure, computeBackoffMs, id, nowIso, truncateToTokenBudget } from "./core.js";

/**
 * @typedef {Object} AIRequest
 * @property {"research"|"personalization"|"claim_validation"|"lead_summary"} operation
 * @property {string} systemPrompt
 * @property {string} userPrompt
 * @property {number} [maxOutputTokens]
 * @property {number} [temperature]
 */

async function callGemini(env, request, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: request.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
    generationConfig: {
      temperature: request.temperature ?? Number(env.AI_TEMPERATURE ?? 0.2),
      maxOutputTokens: request.maxOutputTokens ?? Number(env.AI_MAX_OUTPUT_TOKENS ?? 800)
    }
  };
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await response.text();
  if (!response.ok) { const err = new Error(`Gemini ${response.status}`); err.status = response.status; err.body = raw; throw err; }
  const payload = JSON.parse(raw);
  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return {
    text, provider: "gemini", model,
    inputTokens: payload?.usageMetadata?.promptTokenCount, outputTokens: payload?.usageMetadata?.candidatesTokenCount,
    requestId: response.headers.get("x-request-id") || null
  };
}

async function callGroq(env, request, model) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.userPrompt }],
      temperature: request.temperature ?? Number(env.AI_TEMPERATURE ?? 0.2),
      max_tokens: request.maxOutputTokens ?? Number(env.AI_MAX_OUTPUT_TOKENS ?? 800)
    })
  });
  const raw = await response.text();
  if (!response.ok) { const err = new Error(`Groq ${response.status}`); err.status = response.status; err.body = raw; throw err; }
  const payload = JSON.parse(raw);
  return {
    text: payload?.choices?.[0]?.message?.content ?? "", provider: "groq", model,
    inputTokens: payload?.usage?.prompt_tokens, outputTokens: payload?.usage?.completion_tokens, requestId: payload?.id || null
  };
}

async function callCloudflareAI(env, request, model) {
  if (!env.AI || typeof env.AI.run !== "function") { const err = new Error("Cloudflare AI binding not configured"); err.status = 400; throw err; }
  let result;
  try {
    result = await env.AI.run(model, {
      messages: [{ role: "system", content: request.systemPrompt }, { role: "user", content: request.userPrompt }],
      temperature: request.temperature ?? Number(env.AI_TEMPERATURE ?? 0.2),
      max_tokens: request.maxOutputTokens ?? Number(env.AI_MAX_OUTPUT_TOKENS ?? 800)
    });
  } catch (cause) { const err = new Error(cause.message || "Cloudflare AI request failed"); err.status = 500; throw err; }
  const text = typeof result === "string" ? result : (result?.response ?? "");
  return { text, provider: "cloudflare", model, inputTokens: undefined, outputTokens: undefined, requestId: null };
}

const CALLERS = { gemini: callGemini, groq: callGroq, cloudflare: callCloudflareAI };

function providerConfigured(env, providerName) {
  if (providerName === "gemini") return !!env.GEMINI_API_KEY;
  if (providerName === "groq") return !!env.GROQ_API_KEY;
  if (providerName === "cloudflare") return !!env.AI;
  return false;
}

function tierList(env) {
  const tiers = [
    [env.AI_PRIMARY_PROVIDER, env.AI_PRIMARY_MODEL],
    [env.AI_FALLBACK_PROVIDER, env.AI_FALLBACK_MODEL],
    [env.AI_TERTIARY_PROVIDER, env.AI_TERTIARY_MODEL || "@cf/zai-org/glm-4.7-flash"]
  ].filter(([provider, model]) => provider && model && CALLERS[provider] && providerConfigured(env, provider));
  return tiers;
}

async function recordUsage(env, entry) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      "INSERT INTO ai_usage (id,provider,model,operation,input_tokens,output_tokens,estimated_cost,request_id,status,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id("aiu"), entry.provider, entry.model, entry.operation, entry.inputTokens ?? null, entry.outputTokens ?? null, entry.estimatedCost ?? null, entry.requestId ?? null, entry.status, entry.errorCode ?? null, nowIso()).run();
  } catch (cause) { console.error("ai_usage write failed", cause.message); }
}

/**
 * Deliberately zero: this project is designed to run entirely within Gemini's,
 * Groq's, and Cloudflare Workers AI's free tiers (see README "Free-tier AI
 * provider chain" for current limits), so there should be no real spend to
 * estimate. This stays at 0 rather than a guessed per-token rate so the
 * ai_usage/analytics dashboard never implies a bill that isn't happening; if
 * you outgrow the free tier and move to paid usage, replace these with your
 * plan's actual published rates.
 */
const APPROX_COST_PER_1K_TOKENS = { gemini: 0, groq: 0, cloudflare: 0 };
function estimateCost(provider, inputTokens = 0, outputTokens = 0) {
  const rate = APPROX_COST_PER_1K_TOKENS[provider] ?? 0;
  return Math.round(((inputTokens + outputTokens) / 1000) * rate * 1_000_000) / 1_000_000;
}

/**
 * Calls the configured AI provider chain (primary -> fallback -> tertiary),
 * retrying a transient failure on the SAME provider up to AI_MAX_RETRIES times
 * with exponential backoff before moving to the next provider, and moving on
 * immediately (no retry) for a fatal failure (bad key, malformed request,
 * policy rejection) per spec §8. Every attempt is recorded in ai_usage,
 * success or failure, so cost/failure/fallback rate stays observable.
 * Returns null (never throws) if no provider is configured or every configured
 * provider's chain is exhausted -- callers must have a deterministic fallback
 * path, since AI must never be a hard dependency for the pipeline to function.
 */
export async function callAIWithFallback(env, request) {
  const tiers = tierList(env);
  const maxRetries = Number(env.AI_MAX_RETRIES ?? 2);
  const boundedRequest = { ...request, userPrompt: truncateToTokenBudget(request.userPrompt, Number(env.AI_MAX_INPUT_TOKENS ?? 5000)) };
  let fallbackCount = 0;
  for (const [providerName, model] of tiers) {
    const caller = CALLERS[providerName];
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await caller(env, boundedRequest, model);
        await recordUsage(env, {
          provider: providerName, model, operation: request.operation, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          estimatedCost: estimateCost(providerName, result.inputTokens, result.outputTokens), requestId: result.requestId, status: "success"
        });
        return { ...result, fallback_count: fallbackCount };
      } catch (cause) {
        const classification = classifyAIFailure(cause.status ?? 0, cause.body ?? cause.message ?? "");
        await recordUsage(env, { provider: providerName, model, operation: request.operation, status: "failure", errorCode: String(cause.status ?? "network_error") });
        if (classification === "fatal") break; // don't retry this provider; try the next one
        if (attempt <= maxRetries) { await new Promise((resolve) => setTimeout(resolve, computeBackoffMs(attempt))); continue; }
      }
    }
    fallbackCount += 1;
  }
  return null;
}