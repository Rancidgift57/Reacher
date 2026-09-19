"""Company name -> website domain.

1. Clearbit "name to domain" autocomplete endpoint (free, no key).
   NOTE: Clearbit was folded into HubSpot and this endpoint has been reported as
   sunset. It is kept as a first attempt and fails soft; DuckDuckGo does the real work.
2. DuckDuckGo search fallback (via the `ddgs` package, no key).
"""
import asyncio
import logging
import re
from difflib import SequenceMatcher

import httpx

from config import get_settings
from enrichment.smtp_verifier import domain_accepts_mail
from utils import extract_domain, normalize_name

log = logging.getLogger(__name__)
CLEARBIT_URL = "https://autocomplete.clearbit.com/v1/companies/suggest"

BLOCKED_DOMAINS = {
    "linkedin.com", "crunchbase.com", "techcrunch.com", "venturebeat.com", "facebook.com",
    "twitter.com", "x.com", "instagram.com", "youtube.com", "bloomberg.com", "sec.gov",
    "wikipedia.org", "pitchbook.com", "reddit.com", "medium.com", "ycombinator.com",
    "prnewswire.com", "businesswire.com", "globenewswire.com", "zoominfo.com", "dnb.com",
    "opencorporates.com", "bizapedia.com", "forbes.com", "reuters.com", "wsj.com",
    "apple.com", "google.com", "github.com", "glassdoor.com", "indeed.com", "yahoo.com",
    "tracxn.com", "cbinsights.com", "owler.com", "craft.co", "rocketreach.co", "signalhire.com",
    "sec.report", "secinfo.com", "eincheck.com", "buzzfile.com", "corporationwiki.com",
}


def _similar(company_key: str, domain: str) -> float:
    label = re.sub(r"[^a-z0-9]", "", domain.split(".")[0])
    if not label or not company_key:
        return 0.0
    if company_key in label or label in company_key:
        return 1.0
    return SequenceMatcher(None, company_key, label).ratio()


def _blocked(domain: str) -> bool:
    return any(domain == b or domain.endswith("." + b) for b in BLOCKED_DOMAINS)


async def _clearbit(name: str, key: str, client: httpx.AsyncClient) -> str | None:
    try:
        resp = await client.get(CLEARBIT_URL, params={"query": name})
        if resp.status_code != 200:
            return None
        for item in resp.json()[:3]:
            dom = extract_domain(item.get("domain"))
            if dom and SequenceMatcher(None, key, normalize_name(item.get("name", ""))).ratio() >= 0.7:
                return dom
    except (httpx.HTTPError, ValueError):
        pass
    return None


def _ddg_search(query: str) -> list[dict]:
    try:
        from ddgs import DDGS
    except ImportError:  # legacy package name
        from duckduckgo_search import DDGS
    with DDGS() as d:
        return list(d.text(query, max_results=8))


async def _duckduckgo(name: str, key: str) -> str | None:
    for query in (f'"{name}" official website', f"{name} startup"):
        try:
            results = await asyncio.to_thread(_ddg_search, query)
        except Exception as exc:  # ddgs raises assorted rate-limit exceptions
            log.warning("DuckDuckGo failed for %r: %s", name, exc)
            await asyncio.sleep(2)
            continue
        for r in results:
            dom = extract_domain(r.get("href") or r.get("url"))
            if dom and not _blocked(dom) and _similar(key, dom) >= 0.6:
                return dom
    return None


async def resolve_domain(company_name: str) -> tuple[str | None, str | None]:
    """Returns (domain, source) or (None, None). The domain must have MX/A records."""
    key = normalize_name(company_name)
    if not key:
        return None, None
    s = get_settings()
    async with httpx.AsyncClient(headers={"User-Agent": s.http_user_agent}, timeout=10) as client:
        dom = await _clearbit(company_name, key, client)
    source = "clearbit"
    if not dom:
        dom, source = await _duckduckgo(company_name, key), "duckduckgo"
        await asyncio.sleep(1.0)  # be polite to DDG
    if dom and await domain_accepts_mail(dom):
        return dom, source
    return None, None
