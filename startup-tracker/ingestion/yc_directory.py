"""Y Combinator recent-batch companies.

Uses the open `yc-oss` JSON mirror (static files on GitHub Pages) instead of
scraping ycombinator.com with a headless browser: faster, free and far less
fragile. YC provides the company website directly, so domain discovery is skipped.
"""
import logging
from datetime import date

import httpx

from config import get_settings
from models.schemas import RawStartup
from utils import extract_domain, get_with_retry

log = logging.getLogger(__name__)
BATCH_URL = "https://yc-oss.github.io/api/batches/{slug}.json"


def recent_batch_slugs(today: date | None = None) -> list[str]:
    today = today or date.today()
    seasons = ["winter", "spring", "summer", "fall"]
    slugs = []
    for year in (today.year, today.year - 1):
        for season in seasons:
            slugs.append(f"{season}-{year}")
    return slugs[:6]


async def fetch_yc_startups(max_batches: int = 2) -> list[RawStartup]:
    s = get_settings()
    out: list[RawStartup] = []
    found_batches = 0
    async with httpx.AsyncClient(
        headers={"User-Agent": s.http_user_agent}, timeout=30, follow_redirects=True
    ) as client:
        # Newest first: try upcoming/current seasons of this year, then previous year.
        order = sorted(recent_batch_slugs(), key=lambda x: (int(x[-4:]), ["winter", "spring", "summer", "fall"].index(x.split("-")[0])), reverse=True)
        for slug in order:
            if found_batches >= max_batches:
                break
            try:
                resp = await get_with_retry(client, BATCH_URL.format(slug=slug))
            except httpx.HTTPError:
                continue
            if resp.status_code != 200:
                continue
            found_batches += 1
            for c in resp.json():
                name = c.get("name")
                if not name:
                    continue
                out.append(RawStartup(
                    company_name=name, source="yc", domain=extract_domain(c.get("website")),
                    source_url=c.get("url") or f"https://www.ycombinator.com/companies/{c.get('slug', '')}",
                    industry=(c.get("industry") or None), state=None,
                ))
    log.info("YC: %d companies from %d batches", len(out), found_batches)
    return out
