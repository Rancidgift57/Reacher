"""SEC EDGAR Form D ingestion.

Strategy
  1. Query the EDGAR full-text search index (efts.sec.gov) for Form D filings in a date window.
  2. If that fails or returns nothing, fall back to the "current filings" Atom feed.
  3. For every filing, download `primary_doc.xml` and extract issuer + executive officers.

SEC fair-access rules: every request carries a descriptive User-Agent and we stay
well below 10 requests/second.
"""
import asyncio
import logging
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

import feedparser
import httpx

from config import get_settings
from models.schemas import RawPerson, RawStartup
from utils import get_with_retry

log = logging.getLogger(__name__)

EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
ATOM_URL = "https://www.sec.gov/cgi-bin/browse-edgar"
PRIMARY_DOC_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/primary_doc.xml"
FILING_INDEX_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/"

# Form D "industry group" values that are almost never startups.
EXCLUDED_INDUSTRIES = {
    "pooled investment fund", "hedge fund", "private equity fund", "venture capital fund",
    "other investment fund", "reits and finance", "residential", "commercial",
    "other real estate", "construction", "oil and gas", "insurance",
    "investing", "banking and financial services", "other banking and financial services",
}
_ENTITY_WORDS = re.compile(r"\b(inc|llc|lp|l\.p|ltd|fund|capital|partners|trust|holdings|corp)\b", re.I)


class _Throttle:
    """Serialises requests to <= ~6/sec (SEC limit is 10/sec)."""

    def __init__(self, interval: float = 0.17):
        self.interval, self._lock, self._last = interval, asyncio.Lock(), 0.0

    async def wait(self) -> None:
        async with self._lock:
            loop = asyncio.get_running_loop()
            delta = loop.time() - self._last
            if delta < self.interval:
                await asyncio.sleep(self.interval - delta)
            self._last = loop.time()


# --------------------------------------------------------------------------
# Form D XML parsing (pure function -> easy to unit-test)
# --------------------------------------------------------------------------
def _txt(node: ET.Element | None, path: str) -> str | None:
    if node is None:
        return None
    el = node.find(path)
    return el.text.strip() if el is not None and el.text and el.text.strip() else None


def _money(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value.replace(",", "").replace("$", ""))
    except ValueError:
        return None  # e.g. "Indefinite"


def parse_form_d(xml_text: str) -> dict | None:
    root = ET.fromstring(xml_text)
    for el in root.iter():  # strip XML namespaces
        el.tag = el.tag.split("}", 1)[-1]

    issuer = root.find("primaryIssuer")
    if issuer is None:
        return None
    name = _txt(issuer, "entityName")
    if not name:
        return None

    industry = _txt(root, "offeringData/industryGroup/industryGroupType")
    sold = _money(_txt(root, "offeringData/offeringSalesAmounts/totalAmountSold"))
    offering = _money(_txt(root, "offeringData/offeringSalesAmounts/totalOfferingAmount"))

    people: list[RawPerson] = []
    for info in root.findall("relatedPersonsList/relatedPersonInfo"):
        first = _txt(info, "relatedPersonName/firstName") or ""
        last = _txt(info, "relatedPersonName/lastName") or ""
        rels = [r.text.strip() for r in info.findall("relatedPersonRelationshipList/relationship") if r.text]
        if not first or not last or _ENTITY_WORDS.search(f"{first} {last}"):
            continue
        if not any(r in ("Executive Officer", "Director") for r in rels):
            continue
        clarification = _txt(info, "relationshipClarification")
        title = clarification or " / ".join(rels)
        people.append(RawPerson(first_name=first.title(), last_name=last.title(), title=title))
    # executive officers first
    people.sort(key=lambda p: 0 if p.title and "director" not in p.title.lower() else 1)

    return {
        "name": name,
        "entity_type": _txt(issuer, "entityType"),
        "state": _txt(issuer, "issuerAddress/stateOrCountry"),
        "industry": industry,
        "amount": sold if sold else offering,
        "people": people,
    }


# --------------------------------------------------------------------------
# Discovery of filings
# --------------------------------------------------------------------------
def _clean_display_name(display: str) -> str:
    return re.sub(r"\s*\((?:CIK\s*)?\d{6,10}\)|\s*\([A-Z.,\- ]{1,8}\)\s*$", "", display).strip()


class SecEdgarClient:
    def __init__(self) -> None:
        s = get_settings()
        self.settings = s
        self.client = httpx.AsyncClient(
            headers={"User-Agent": s.sec_user_agent, "Accept-Encoding": "gzip, deflate"},
            timeout=30,
            follow_redirects=True,
        )
        self.throttle = _Throttle()

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _get(self, url: str, **kw) -> httpx.Response:
        await self.throttle.wait()
        return await get_with_retry(self.client, url, **kw)

    async def _search_efts(self, start: date, end: date, limit: int) -> list[dict]:
        hits: list[dict] = []
        offset = 0
        while len(hits) < limit:
            params = {
                "forms": "D", "dateRange": "custom",
                "startdt": start.isoformat(), "enddt": end.isoformat(), "from": offset,
            }
            resp = await self._get(EFTS_URL, params=params)
            resp.raise_for_status()
            page = resp.json().get("hits", {}).get("hits", [])
            if not page:
                break
            for h in page:
                src = h.get("_source", {})
                ciks = src.get("ciks") or []
                names = src.get("display_names") or []
                acc = src.get("adsh") or h.get("_id", "").split(":")[0]
                if not (ciks and acc and names):
                    continue
                hits.append({
                    "cik": str(ciks[0]).zfill(10), "acc": acc,
                    "name": _clean_display_name(names[0]),
                    "file_date": src.get("file_date"),
                })
            offset += len(page)
        return hits[:limit]

    async def _search_atom(self, limit: int) -> list[dict]:
        params = {"action": "getcurrent", "type": "D", "count": min(limit, 100),
                  "output": "atom", "owner": "include"}
        resp = await self._get(ATOM_URL, params=params)
        resp.raise_for_status()
        out = []
        for e in feedparser.parse(resp.text).entries:
            m = re.match(r"^D(?:/A)? - (.+?) \((\d{10})\)", e.get("title", ""))
            acc = re.search(r"accession-number=([\d-]+)", e.get("id", ""))
            if m and acc:
                out.append({"cik": m.group(2), "acc": acc.group(1), "name": m.group(1).strip(),
                            "file_date": (e.get("updated") or "")[:10] or None})
        return out[:limit]

    async def _hydrate(self, hit: dict) -> RawStartup | None:
        acc_nodash = hit["acc"].replace("-", "")
        cik_int = str(int(hit["cik"]))
        url = PRIMARY_DOC_URL.format(cik=cik_int, acc_nodash=acc_nodash)
        try:
            resp = await self._get(url)
            if resp.status_code != 200:
                return None
            parsed = parse_form_d(resp.text)
        except (httpx.HTTPError, ET.ParseError) as exc:
            log.warning("Form D fetch/parse failed for %s: %s", hit["name"], exc)
            return None
        if not parsed:
            return None
        if (parsed["industry"] or "").lower() in EXCLUDED_INDUSTRIES:
            return None
        filed = None
        if hit.get("file_date"):
            try:
                filed = datetime.strptime(hit["file_date"][:10], "%Y-%m-%d").date()
            except ValueError:
                pass
        return RawStartup(
            company_name=parsed["name"], source="sec_form_d",
            source_url=FILING_INDEX_URL.format(cik=cik_int, acc_nodash=acc_nodash),
            cik=hit["cik"], filing_date=filed, amount_raised=parsed["amount"],
            industry=parsed["industry"], state=parsed["state"], people=parsed["people"],
        )

    async def fetch_recent(self) -> list[RawStartup]:
        s = self.settings
        end = date.today()
        start = end - timedelta(days=s.sec_lookback_days)
        try:
            hits = await self._search_efts(start, end, s.sec_max_filings)
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("EFTS search failed (%s); using Atom fallback", exc)
            hits = []
        if not hits:
            try:
                hits = await self._search_atom(s.sec_max_filings)
            except httpx.HTTPError as exc:
                log.error("Atom fallback failed: %s", exc)
                return []

        seen: set[str] = set()
        unique = [h for h in hits if not (h["acc"] in seen or seen.add(h["acc"]))]
        results = await asyncio.gather(*(self._hydrate(h) for h in unique))
        found = [r for r in results if r]
        log.info("SEC: %d filings -> %d startup-like issuers", len(unique), len(found))
        return found


async def fetch_sec_startups() -> list[RawStartup]:
    client = SecEdgarClient()
    try:
        return await client.fetch_recent()
    finally:
        await client.aclose()
