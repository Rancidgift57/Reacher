"""Funding-news RSS ingestion (TechCrunch, VentureBeat, ...)."""
import logging
import re
from datetime import date, datetime

import feedparser
import httpx

from config import get_settings
from models.schemas import RawStartup
from utils import get_with_retry

log = logging.getLogger(__name__)

_VERBS = (
    r"raises|raised|secures|secured|lands|landed|closes|closed|bags|snags|nabs|"
    r"scores|gets|banks|pulls in|announces|receives|picks up|rakes in|locks in|adds"
)
_TITLE_RE = re.compile(rf"^(?P<name>[^:–—|]{{2,60}}?)\s+(?:{_VERBS})\b(?P<rest>.*)$", re.I)
_AMOUNT_RE = re.compile(r"\$\s?(?P<n>[\d,.]+)\s?(?P<u>billion|million|thousand|bn|b|m|k)\b", re.I)
_FUNDING_HINT = re.compile(r"\b(raise[sd]?|funding|seed|series [a-e]|pre-seed|venture|round|invest)", re.I)
_MULT = {"billion": 1e9, "bn": 1e9, "b": 1e9, "million": 1e6, "m": 1e6, "thousand": 1e3, "k": 1e3}


def parse_amount(text: str) -> float | None:
    m = _AMOUNT_RE.search(text)
    if not m:
        return None
    try:
        return float(m.group("n").replace(",", "")) * _MULT[m.group("u").lower()]
    except ValueError:
        return None


def parse_title(title: str) -> tuple[str, float | None] | None:
    """'Acme raises $12M Series A to build robots' -> ('Acme', 12_000_000.0)."""
    if not _FUNDING_HINT.search(title):
        return None
    m = _TITLE_RE.match(title.strip())
    if not m:
        return None
    name = re.sub(r"^(exclusive|report|breaking)\s*[:\-]\s*", "", m.group("name"), flags=re.I).strip(" ,'\"")
    if not name or len(name.split()) > 6:  # long "names" are usually sentences
        return None
    return name, parse_amount(title)


def _entry_date(entry) -> date | None:
    t = entry.get("published_parsed") or entry.get("updated_parsed")
    return datetime(*t[:6]).date() if t else None


async def fetch_rss_startups() -> list[RawStartup]:
    s = get_settings()
    out: list[RawStartup] = []
    async with httpx.AsyncClient(
        headers={"User-Agent": s.http_user_agent}, timeout=30, follow_redirects=True
    ) as client:
        for feed_url in s.rss_feed_list:
            try:
                resp = await get_with_retry(client, feed_url)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                log.warning("RSS fetch failed for %s: %s", feed_url, exc)
                continue
            for entry in feedparser.parse(resp.text).entries:
                parsed = parse_title(entry.get("title", ""))
                if not parsed:
                    continue
                name, amount = parsed
                out.append(RawStartup(
                    company_name=name, source="rss", source_url=entry.get("link"),
                    filing_date=_entry_date(entry), amount_raised=amount,
                ))
    log.info("RSS: %d funding items", len(out))
    return out
