-- Upgrade migration for an ALREADY DEPLOYED Argmax Outreach database.
-- A brand-new database should just run schema.sql instead; this file exists so an
-- existing D1 instance can be brought up to date without losing data.
--
-- Apply with:
--   npx wrangler d1 execute argmax-outreach --remote --file=migrations/0002_startup_discovery_upgrade.sql
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS, or guarded by a
-- best-effort ALTER that D1/SQLite will simply error on if already applied --
-- in that case just skip the failing statement and continue with the rest).

PRAGMA foreign_keys = OFF;

-- 1. New columns on existing tables -----------------------------------------------
ALTER TABLE discovery_sources ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'rss_headline';
ALTER TABLE contacts ADD COLUMN discovery_source TEXT;

-- 2. contacts.verification_status needs 'pending' added to its CHECK constraint.
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
CREATE TABLE contacts_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  role_evidence_url TEXT,
  email_source TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unknown' CHECK(verification_status IN ('unknown','pending','valid','risky','catch_all','invalid','disposable')),
  verified_at TEXT,
  contact_basis TEXT NOT NULL DEFAULT 'unknown',
  policy_status TEXT NOT NULL DEFAULT 'hold' CHECK(policy_status IN ('eligible','hold','blocked')),
  country_code TEXT,
  discovery_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO contacts_new SELECT id,company_id,email,first_name,last_name,title,role_evidence_url,email_source,verification_status,verified_at,contact_basis,policy_status,country_code,discovery_source,created_at,updated_at FROM contacts;
DROP TABLE contacts;
ALTER TABLE contacts_new RENAME TO contacts;
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_verification ON contacts(verification_status);

-- 3. Brand-new tables ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES discovery_sources(id),
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
  items_found INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  items_duplicate INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_reports (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  company_summary TEXT NOT NULL,
  recent_signals_json TEXT NOT NULL DEFAULT '[]',
  potential_needs_json TEXT NOT NULL DEFAULT '[]',
  argmax_services_json TEXT NOT NULL DEFAULT '[]',
  reason_for_contact TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  ai_provider TEXT NOT NULL DEFAULT 'deterministic_evidence_synthesizer',
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_reasons (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  why_json TEXT NOT NULL DEFAULT '[]',
  argmax_needs_json TEXT NOT NULL DEFAULT '[]',
  reason_for_contact TEXT,
  signal_score INTEGER NOT NULL DEFAULT 0,
  signal_score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  enrollment_id TEXT REFERENCES enrollments(id),
  outbox_id TEXT REFERENCES outbox(id),
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','high','error')),
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_source ON discovery_runs(source_id, started_at);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(created_at);

PRAGMA foreign_keys = ON;
