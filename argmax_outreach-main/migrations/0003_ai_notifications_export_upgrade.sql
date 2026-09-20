-- Upgrade migration for an ALREADY DEPLOYED Argmax Outreach database that already
-- has the 0002_startup_discovery_upgrade.sql migration applied.
-- A brand-new database should just run schema.sql instead.
--
-- Apply with:
--   npx wrangler d1 execute argmax-outreach --remote --file=migrations/0003_ai_notifications_export_upgrade.sql
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS).

ALTER TABLE research_reports ADD COLUMN ai_research_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE research_reports ADD COLUMN ai_model TEXT;

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost REAL,
  request_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('success','failure')),
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  event_type TEXT PRIMARY KEY,
  dashboard INTEGER NOT NULL DEFAULT 1,
  slack INTEGER NOT NULL DEFAULT 0,
  discord INTEGER NOT NULL DEFAULT 0,
  email INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_drafts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  contact_id TEXT REFERENCES contacts(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  personalization_points_json TEXT NOT NULL DEFAULT '[]',
  claims_used_json TEXT NOT NULL DEFAULT '[]',
  validation_json TEXT NOT NULL DEFAULT '{}',
  valid INTEGER NOT NULL DEFAULT 0,
  ai_provider TEXT,
  ai_model TEXT,
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_operation ON ai_usage(operation, created_at);
CREATE INDEX IF NOT EXISTS idx_email_drafts_company ON email_drafts(company_id);
