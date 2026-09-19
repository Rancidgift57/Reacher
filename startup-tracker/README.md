# Startup Funding Tracker

Free pipeline + dashboard: ingests newly funded startups (SEC Form D, TechCrunch/VentureBeat RSS,
Y Combinator batches), finds their domain, discovers decision-maker emails, verifies them over SMTP,
stores everything in Postgres/SQLite and pushes a daily digest to Discord/Slack.

## Directory structure
```
startup-tracker/
├── main.py                  FastAPI app: /api/startups, /api/stats, /api/pipeline/run, dashboard at /
├── config.py                Settings (env vars / .env)
├── db.py                    Engine + session
├── utils.py                 Name normalisation, domain parsing, HTTP retry
├── ingestion/
│   ├── sec_edgar.py         Form D via EDGAR search-index (+ Atom fallback), parses primary_doc.xml
│   ├── rss_parser.py        TechCrunch / VentureBeat funding headlines
│   └── yc_directory.py      Recent YC batches (open JSON mirror, no browser needed)
├── enrichment/
│   ├── domain_resolver.py   Clearbit -> DuckDuckGo, MX-validated
│   ├── email_permutator.py  first.last@, first@, flast@, ceo@ ...
│   ├── smtp_verifier.py     dnspython MX + SMTP RCPT handshake, catch-all detection
│   ├── apollo_client.py     Apollo free API (budget-guarded)
│   ├── hunter_client.py     Hunter free API (budget-guarded)
│   └── rate_limit.py        Rate limiter + persistent monthly credit budget
├── models/
│   ├── orm.py               SQLAlchemy models (UNIQUE cik / company_domain / name_key)
│   └── schemas.py           Pydantic models
├── tasks/
│   ├── pipeline.py          Orchestrator: ingest -> dedupe -> enrich -> alert
│   ├── alerts.py            Discord / Slack / generic webhook
│   ├── celery_app.py        Celery app + beat schedule
│   └── jobs.py              Celery task wrapper
├── static/index.html        Dashboard
├── scripts/run_once.py      CLI: run the pipeline once
└── tests/test_smoke.py      Offline tests
```

## Setup (local, free)
```bash
python3.11 -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then edit .env
```
1. **Set `SEC_USER_AGENT`** in `.env` to your real contact (SEC blocks generic agents).
2. Set `SMTP_HELO_HOST` / `SMTP_MAIL_FROM` to a domain and address you control.
3. Optional: `APOLLO_API_KEY`, `HUNTER_API_KEY`, `WEBHOOK_URL`.

Verify the install: `pytest -q`

### Run (simplest: no Redis)
```bash
uvicorn main:app --reload
```
Open http://localhost:8000 for the dashboard and http://localhost:8000/docs for the API.
`SCHEDULER_MODE=apscheduler` (default) runs the pipeline daily at 06:00 UTC inside the same process.
Run it right now with the dashboard button, or:
```bash
python -m scripts.run_once
```

### Run with Celery + Redis
```bash
docker compose up -d                       # Redis
# .env: SCHEDULER_MODE=celery
uvicorn main:app
celery -A tasks.celery_app worker -l info  # add --pool=solo on Windows
celery -A tasks.celery_app beat -l info
```

### Postgres on Supabase (free)
Create a project, copy the **transaction pooler** connection string into `DATABASE_URL`. Tables are
created automatically on startup.

### Free hosting
Any always-on free VM (e.g. Oracle Cloud Always Free) works. Note that most cloud hosts block
outbound port 25, which disables SMTP verification (see below).

## API
`GET /api/startups?page=1&page_size=25&q=acme&source=sec_form_d&has_email=true&since=2026-09-01`
returns `{items, total, page, page_size, pages}`; each item includes its contacts.
Also: `GET /api/startups/{id}`, `GET /api/stats`, `POST /api/pipeline/run` (header `X-API-Key` if `API_KEY` is set).

## Things you should know
* **Port 25:** SMTP verification needs outbound port 25. Most home ISPs and cloud providers block it;
  results then degrade to `guessed` (best-pattern guess, clearly labelled). Catch-all domains are
  labelled `catch_all`. Verification is a strong signal, not proof.
* **Clearbit autocomplete** has been reported as sunset since HubSpot's acquisition; the resolver
  fails soft and DuckDuckGo does the work.
* **Apollo / Hunter free plans:** API access and limits vary by plan. Budgets in `.env`
  (`APOLLO_MONTHLY_BUDGET`, `HUNTER_MONTHLY_BUDGET`) stop the pipeline from overspending.
* **Form D noise:** the filter drops pooled funds and real estate; some non-startups still get through.
  RSS company names are extracted heuristically from headlines.
* **Compliance:** this collects business contact data. If you email people, follow CAN-SPAM / GDPR /
  PECR (identify yourself, honour opt-outs, have a lawful basis for EU contacts).
* The SEC, YC-mirror and feed parsers were unit-tested offline against sample data; run
  `python -m scripts.run_once` once to confirm live endpoints behave on your network.
