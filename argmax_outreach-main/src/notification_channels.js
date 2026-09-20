import { buildDiscordMessage, buildSlackMessage, resolveNotificationChannels } from "./core.js";

async function loadPreferences(env) {
  if (!env.DB) return {};
  try {
    const { results } = await env.DB.prepare("SELECT * FROM notification_preferences").all();
    const preferences = {};
    for (const row of results || []) preferences[row.event_type] = { dashboard: !!row.dashboard, slack: !!row.slack, discord: !!row.discord, email: !!row.email };
    return preferences;
  } catch (cause) { console.error("notification_preferences read failed", cause.message); return {}; }
}

async function sendSlack(env, notification) {
  if (env.SLACK_ENABLED !== "true" || !env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildSlackMessage(notification)) });
  } catch (cause) { console.error("Slack notification failed", cause.message); }
}

async function sendDiscord(env, notification) {
  if (env.DISCORD_ENABLED !== "true" || !env.DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildDiscordMessage(notification)) });
  } catch (cause) { console.error("Discord notification failed", cause.message); }
}

/**
 * Dispatches a just-created notification to whichever external channels its
 * event type is configured for (spec §21-25). The dashboard feed itself is
 * always populated by the DB insert this runs alongside (see insertNotification
 * in src/index.js) -- this function only handles the *external* channels, and
 * never throws: a failed webhook must never break the discovery/research/send
 * pipeline that triggered the notification.
 */
export async function dispatchNotification(env, notification) {
  const preferences = await loadPreferences(env);
  const channels = resolveNotificationChannels(preferences, notification.type);
  const sends = [];
  if (channels.slack) sends.push(sendSlack(env, notification));
  if (channels.discord) sends.push(sendDiscord(env, notification));
  // Internal notification email (distinct from outreach email, spec §24) is left
  // as a documented extension point: it would reuse the same EmailProvider
  // adapter used for outreach, but with a hard-coded internal recipient rather
  // than a contact record, and should never share a send-queue with outreach.
  await Promise.all(sends);
}
