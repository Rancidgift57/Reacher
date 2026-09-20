"""FastAPI app: REST API + dashboard + (optional) in-process scheduler."""
import logging
import math
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timezone
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from config import get_settings
from db import get_db, init_db
from enrichment.smtp_verifier import SMTPVerifier
from models.orm import Contact, Startup
from models.schemas import Page, StartupOut
from tasks.pipeline import run_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings = get_settings()
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = None
    if settings.scheduler_mode == "apscheduler":
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.cron import CronTrigger

        scheduler = AsyncIOScheduler(timezone="UTC")
        scheduler.add_job(
            run_pipeline,
            CronTrigger(hour=settings.pipeline_cron_hour, minute=settings.pipeline_cron_minute),
            id="daily-pipeline", max_instances=1, coalesce=True,
        )
        scheduler.start()
        logging.info("APScheduler started (daily at %02d:%02d UTC)",
                     settings.pipeline_cron_hour, settings.pipeline_cron_minute)
    yield
    if scheduler:
        scheduler.shutdown(wait=False)


app = FastAPI(title="Startup Funding Tracker", version="1.0.0", lifespan=lifespan)


@app.get("/api/startups", response_model=Page)
def list_startups(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    q: str | None = Query(None, description="Search company name or domain"),
    source: str | None = Query(None, description="sec_form_d | rss | yc"),
    has_email: bool | None = Query(None, description="Only startups with at least one email"),
    since: date | None = Query(None, description="Discovered on/after this date"),
    db: Session = Depends(get_db),
):
    stmt = select(Startup)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(func.lower(Startup.company_name).like(like) | func.lower(Startup.company_domain).like(like))
    if source:
        stmt = stmt.where(Startup.source == source)
    if since:
        stmt = stmt.where(Startup.created_at >= datetime.combine(since, time.min, tzinfo=timezone.utc))
    if has_email:
        stmt = stmt.where(Startup.id.in_(select(Contact.startup_id).where(Contact.email.is_not(None))))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(
        stmt.order_by(Startup.created_at.desc(), Startup.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    return Page(items=[StartupOut.model_validate(r) for r in rows], total=total, page=page,
                page_size=page_size, pages=max(1, math.ceil(total / page_size)))


@app.get("/api/startups/{startup_id}", response_model=StartupOut)
def get_startup(startup_id: int, db: Session = Depends(get_db)):
    st = db.get(Startup, startup_id)
    if not st:
        raise HTTPException(404, "Startup not found")
    return st


@app.get("/api/stats")
def stats(db: Session = Depends(get_db)):
    by_source = dict(db.execute(select(Startup.source, func.count()).group_by(Startup.source)).all())
    return {
        "startups": db.scalar(select(func.count(Startup.id))) or 0,
        "with_email": db.scalar(select(func.count(func.distinct(Contact.startup_id))).where(Contact.email.is_not(None))) or 0,
        "verified_emails": db.scalar(select(func.count(Contact.id)).where(Contact.email_status == "valid")) or 0,
        "pending": db.scalar(select(func.count(Startup.id)).where(Startup.enrichment_status == "pending")) or 0,
        "by_source": by_source,
    }


@app.post("/api/pipeline/run", status_code=202)
async def trigger_pipeline(background: BackgroundTasks, x_api_key: str | None = Header(None)):
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(401, "Invalid or missing X-API-Key")
    if settings.scheduler_mode == "celery":
        from tasks.jobs import run_pipeline_task
        run_pipeline_task.delay()
    else:
        background.add_task(run_pipeline)
    return {"status": "queued"}


# ---------------------------------------------------------------------------
# Real SMTP-level email verification, exposed over HTTP for other services
# (e.g. the Cloudflare-Worker-based Argmax Outreach project) to call. This
# just wraps the existing SMTPVerifier -- no new verification logic -- because
# Cloudflare Workers cannot open outbound TCP connections on port 25 (the
# Workers runtime blocks it by default), so the actual RCPT-TO handshake has
# to run somewhere with normal outbound network access, like this FastAPI app.
# One process-lifetime SMTPVerifier instance is reused across requests so its
# internal MX/catch-all caches (see enrichment/smtp_verifier.py) actually help.
# ---------------------------------------------------------------------------
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_verifier = SMTPVerifier()


class VerifyEmailRequest(BaseModel):
    email: str


@app.post("/api/verify-email")
async def verify_email(payload: VerifyEmailRequest, x_api_key: str | None = Header(None)):
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(401, "Invalid or missing X-API-Key")
    email = payload.email.strip()
    if not _EMAIL_RE.match(email):
        return {"email": email, "status": "invalid", "detail": "malformed address"}
    result = await _verifier.verify(email)
    return {"email": result.email, "status": result.status, "detail": result.detail}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def dashboard():
    return FileResponse(STATIC / "index.html")
