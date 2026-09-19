"""Pipeline orchestrator: ingest -> dedupe -> enrich -> alert.

`run_pipeline()` is called by APScheduler, by the Celery task, by the CLI
script and by POST /api/pipeline/run.
"""
import asyncio
import logging
import threading
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import get_settings
from db import SessionLocal, init_db
from enrichment.apollo_client import ApolloClient
from enrichment.domain_resolver import resolve_domain
from enrichment.email_permutator import generate_candidates, generic_candidates
from enrichment.hunter_client import HunterClient
from enrichment.smtp_verifier import SMTPVerifier
from ingestion.rss_parser import fetch_rss_startups
from ingestion.sec_edgar import fetch_sec_startups
from ingestion.yc_directory import fetch_yc_startups
from models.orm import Contact, Startup
from models.schemas import RawStartup
from tasks.alerts import send_digest
from utils import extract_domain, normalize_name

log = logging.getLogger(__name__)
_run_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# Upsert / deduplication
# --------------------------------------------------------------------------
def _add_contact(st: Startup, first: str, last: str, title: str | None, email: str | None,
                 status: str, source: str, linkedin: str | None = None) -> Contact | None:
    full = f"{first} {last}".strip() or None
    for c in st.contacts:
        if (email and c.email == email) or (full and c.full_name == full and not email):
            return None
    c = Contact(first_name=first or None, last_name=last or None, full_name=full, title=title,
                email=email, email_status=status, email_source=source, linkedin_url=linkedin)
    st.contacts.append(c)
    return c


def upsert_startup(session: Session, raw: RawStartup) -> tuple[Startup, bool]:
    """Insert or merge. Match order: CIK -> normalised name -> domain."""
    key = normalize_name(raw.company_name)
    if not key:
        raise ValueError("empty company name")
    st = None
    if raw.cik:
        st = session.scalar(select(Startup).where(Startup.cik == raw.cik))
    if st is None:
        st = session.scalar(select(Startup).where(Startup.name_key == key))
    if st is None and raw.domain:
        st = session.scalar(select(Startup).where(Startup.company_domain == raw.domain))

    created = st is None
    if created:
        st = Startup(company_name=raw.company_name, name_key=key, cik=raw.cik, source=raw.source,
                     source_url=raw.source_url, filing_date=raw.filing_date,
                     amount_raised=raw.amount_raised, industry=raw.industry, state=raw.state)
        if raw.domain:
            st.company_domain, st.domain_source = raw.domain, "source"
        session.add(st)
    else:  # merge richer information from the new record
        if raw.cik and not st.cik:
            st.cik = raw.cik
        if raw.amount_raised and not st.amount_raised:
            st.amount_raised = raw.amount_raised
        if raw.industry and not st.industry:
            st.industry = raw.industry
        if raw.domain and not st.company_domain and not session.scalar(
                select(Startup.id).where(Startup.company_domain == raw.domain)):
            st.company_domain, st.domain_source = raw.domain, "source"

    for p in raw.people[:4]:
        _add_contact(st, p.first_name, p.last_name, p.title, None, "unverified", "form_d")
    session.commit()
    return st, created


# --------------------------------------------------------------------------
# Enrichment
# --------------------------------------------------------------------------
class Enricher:
    def __init__(self) -> None:
        self.verifier = SMTPVerifier()
        self.apollo = ApolloClient()
        self.hunter = HunterClient()

    async def aclose(self) -> None:
        await self.apollo.aclose()
        await self.hunter.aclose()

    async def enrich(self, startup_id: int) -> None:
        with SessionLocal() as s:
            st = s.get(Startup, startup_id)
            if st is None:
                return
            try:
                await self._enrich(s, st)
            except Exception:
                log.exception("Enrichment failed for %s", st.company_name)
                s.rollback()
                st = s.get(Startup, startup_id)
                st.enrichment_status = "failed"
                st.enriched_at = _now()
                s.commit()

    async def _enrich(self, s: Session, st: Startup) -> None:
        # 1. domain ---------------------------------------------------------
        if not st.company_domain:
            domain, source = await resolve_domain(st.company_name)
            if not domain:
                st.enrichment_status, st.enriched_at = "no_domain", _now()
                s.commit()
                return
            clash = s.scalar(select(Startup.id).where(Startup.company_domain == domain, Startup.id != st.id))
            if clash:  # same company already tracked under another record
                st.enrichment_status, st.enriched_at = "duplicate", _now()
                s.commit()
                return
            st.company_domain, st.domain_source = domain, source
            s.commit()
        domain = st.company_domain

        # 2. named people from Form D -> free permutation + SMTP first -----
        for c in [c for c in st.contacts if not c.email and c.first_name and c.last_name]:
            cands = generate_candidates(c.first_name, c.last_name, domain)
            email, status = await self.verifier.find_valid(cands, domain)
            if email and status in ("valid", "catch_all"):
                c.email, c.email_status, c.email_source = email, status, "permutation"
                continue
            # paid free-tier fallbacks, only when the free route was inconclusive
            person = await self.apollo.match_person(c.first_name, c.last_name, domain)
            if person and person.email:
                c.email, c.email_source = person.email, "apollo"
                c.email_status = "valid" if person.email_status == "verified" else "unverified"
                c.linkedin_url = person.linkedin_url
                continue
            found = await self.hunter.email_finder(domain, c.first_name, c.last_name)
            if found:
                c.email, c.email_status, c.email_source = found.email, "unverified", "hunter"
                continue
            if email:  # best guess (e.g. port 25 blocked)
                c.email, c.email_status, c.email_source = email, status, "permutation"
            else:
                c.email_status = "not_found"
        s.commit()

        # 3. no people known (RSS / YC) -> discover decision makers ----------
        if not st.contacts:
            for p in (await self.apollo.search_people(domain))[:2]:
                if p.email:
                    _add_contact(st, p.first_name, p.last_name, p.title, p.email, "unverified", "apollo", p.linkedin_url)
                    continue
                enriched = await self.apollo.match_person(p.first_name, p.last_name, domain, p.apollo_id)
                if enriched and enriched.email:
                    status = "valid" if enriched.email_status == "verified" else "unverified"
                    _add_contact(st, enriched.first_name, enriched.last_name, enriched.title or p.title,
                                 enriched.email, status, "apollo", enriched.linkedin_url)
            if not st.contacts:
                for h in (await self.hunter.domain_search(domain, limit=3)):
                    _add_contact(st, h.first_name, h.last_name, h.title, h.email, "unverified", "hunter")
            s.commit()

        # 4. last resort: a role address (ceo@, founders@, hello@ ...) -------
        if not any(c.email for c in st.contacts):
            email, status = await self.verifier.find_valid(generic_candidates(domain), domain)
            if email:
                _add_contact(st, "", "", "Generic inbox", email, status, "generic")

        st.enrichment_status, st.enriched_at = "done", _now()
        s.commit()


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------
async def ingest_all() -> dict:
    s = get_settings()
    sources: dict = {"sec": fetch_sec_startups(), "rss": fetch_rss_startups()}
    if s.yc_enabled:
        sources["yc"] = fetch_yc_startups()
    results = await asyncio.gather(*sources.values(), return_exceptions=True)

    stats = {"fetched": 0, "new": 0}
    with SessionLocal() as session:
        for name, res in zip(sources, results):
            if isinstance(res, Exception):
                log.error("Source %s failed: %r", name, res)
                continue
            for raw in res:
                stats["fetched"] += 1
                try:
                    _, created = upsert_startup(session, raw)
                    stats["new"] += int(created)
                except (IntegrityError, ValueError) as exc:
                    session.rollback()
                    log.debug("Skipped %s: %s", raw.company_name, exc)
    return stats


async def enrich_pending() -> int:
    s = get_settings()
    with SessionLocal() as session:
        ids = list(session.scalars(
            select(Startup.id).where(Startup.enrichment_status == "pending")
            .order_by(Startup.created_at.desc(), Startup.id.desc()).limit(s.max_enrich_per_run)))
    enricher = Enricher()
    sem = asyncio.Semaphore(3)

    async def worker(sid: int) -> None:
        async with sem:
            await enricher.enrich(sid)

    try:
        await asyncio.gather(*(worker(i) for i in ids))
    finally:
        await enricher.aclose()
    return len(ids)


async def alert_new() -> int:
    with SessionLocal() as session:
        fresh = list(session.scalars(
            select(Startup).where(Startup.alerted_at.is_(None), Startup.enrichment_status == "done")
            .order_by(Startup.created_at.desc())))
        if not fresh:
            return 0
        if await send_digest(fresh) or not get_settings().webhook_url:
            for st in fresh:
                st.alerted_at = _now()
            session.commit()
        return len(fresh)


async def run_pipeline() -> dict:
    if not _run_lock.acquire(blocking=False):
        return {"status": "already_running"}
    try:
        init_db()
        log.info("Pipeline started")
        stats = await ingest_all()
        stats["enriched"] = await enrich_pending()
        stats["alerted"] = await alert_new()
        stats["status"] = "ok"
        log.info("Pipeline finished: %s", stats)
        return stats
    finally:
        _run_lock.release()
