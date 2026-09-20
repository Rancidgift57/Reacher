PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  country_code TEXT,
  timezone TEXT,
  employee_band TEXT,
  status TEXT NOT NULL DEFAULT 'researching' CHECK(status IN ('researching','qualified','held','suppressed','active_client')),
  owner_campaign_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL DEFAULT 'rss_headline',
  source_type TEXT NOT NULL CHECK(source_type IN ('rss','json_feed')),
  url TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  interval_minutes INTEGER NOT NULL DEFAULT 720,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES discovery_sources(id),
  source_item_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  extracted_company_name TEXT,
  extracted_domain TEXT,
  extracted_event_type TEXT,
  extraction_confidence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','enriched','rejected','held')),
  rejection_reason TEXT,
  company_id TEXT REFERENCES companies(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, source_item_key)
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_date TEXT,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  evidence_excerpt TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'unreviewed' CHECK(confidence IN ('unreviewed','corroborated','conflicting','rejected')),
  created_at TEXT NOT NULL,
  UNIQUE(company_id, source_key)
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  role_evidence_url TEXT,
  email_source TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unknown' CHECK(verification_status IN ('unknown','pending','valid','risky','catch_all','invalid','disposable')),
  discovery_source TEXT,
  verified_at TEXT,
  contact_basis TEXT NOT NULL DEFAULT 'unknown',
  policy_status TEXT NOT NULL DEFAULT 'hold' CHECK(policy_status IN ('eligible','hold','blocked')),
  country_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qualifications (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  need_score INTEGER NOT NULL DEFAULT 0,
  fit_score INTEGER NOT NULL DEFAULT 0,
  stability_score INTEGER NOT NULL DEFAULT 0,
  timing_score INTEGER NOT NULL DEFAULT 0,
  access_score INTEGER NOT NULL DEFAULT 0,
  practicality_score INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  need_hypothesis TEXT,
  bounded_offer TEXT,
  proof_id TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  required_fields_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES templates(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','archived')),
  country_codes_json TEXT NOT NULL DEFAULT '[]',
  daily_limit INTEGER NOT NULL DEFAULT 10,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','scheduled','active','paused','completed','suppressed','replied','held')),
  current_step INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  hold_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  step INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','accepted','dry_run','send_unknown','cancelled','failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  rendered_subject TEXT NOT NULL,
  rendered_body TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  provider_message_id TEXT,
  claimed_at TEXT,
  accepted_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(enrollment_id, step)
);

CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  email TEXT,
  company_id TEXT REFERENCES companies(id),
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(email IS NOT NULL OR company_id IS NOT NULL),
  UNIQUE(email),
  UNIQUE(company_id)
);

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
  ai_research_json TEXT NOT NULL DEFAULT '{}',
  ai_model TEXT,
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

CREATE TABLE IF NOT EXISTS message_events (
  id TEXT PRIMARY KEY,
  outbox_id TEXT REFERENCES outbox(id),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  usage_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  company_id TEXT REFERENCES companies(id),
  occurred_at TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_company ON signals(company_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON discovery_candidates(status, retrieved_at);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_enrollments_contact ON enrollments(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_source ON discovery_runs(source_id, started_at);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(created_at);
CREATE INDEX IF NOT EXISTS idx_contacts_verification ON contacts(verification_status);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_operation ON ai_usage(operation, created_at);
CREATE INDEX IF NOT EXISTS idx_email_drafts_company ON email_drafts(company_id);
