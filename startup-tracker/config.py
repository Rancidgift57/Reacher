"""Central configuration. Every value can be overridden via environment variable or .env file."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Infrastructure -------------------------------------------------
    database_url: str = "sqlite:///./startups.db"
    redis_url: str = "redis://localhost:6379/0"
    # "apscheduler" = runs inside the FastAPI process (no Redis needed)
    # "celery"      = use Celery worker + beat (needs Redis)
    # "none"        = no automatic schedule (trigger manually)
    scheduler_mode: str = "apscheduler"
    pipeline_cron_hour: int = 6
    pipeline_cron_minute: int = 0

    # --- HTTP identity --------------------------------------------------
    # SEC REQUIRES a descriptive User-Agent with contact info. Change the email!
    sec_user_agent: str = "StartupTracker AdminContact@myproject.com"
    http_user_agent: str = "Mozilla/5.0 (compatible; StartupTracker/1.0)"

    # --- Ingestion ------------------------------------------------------
    sec_lookback_days: int = 2
    sec_max_filings: int = 100
    rss_feeds: str = (
        "https://techcrunch.com/category/startups/feed/,"
        "https://venturebeat.com/feed/"
    )
    yc_enabled: bool = True

    # --- Enrichment -----------------------------------------------------
    max_enrich_per_run: int = 50
    apollo_api_key: str = ""
    apollo_monthly_budget: int = 9000   # stay under the 10k free credits
    hunter_api_key: str = ""
    hunter_monthly_budget: int = 45     # stay under the 50 free credits

    smtp_verify_enabled: bool = True
    smtp_helo_host: str = "example.com"          # use a domain you control
    smtp_mail_from: str = "verify@example.com"   # use an address you control
    smtp_timeout: int = 10
    smtp_concurrency: int = 5
    smtp_max_candidates: int = 8

    # --- Delivery -------------------------------------------------------
    webhook_url: str = ""   # Discord or Slack incoming webhook
    api_key: str = ""       # if set, POST /api/pipeline/run requires X-API-Key

    @property
    def rss_feed_list(self) -> list[str]:
        return [u.strip() for u in self.rss_feeds.split(",") if u.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
