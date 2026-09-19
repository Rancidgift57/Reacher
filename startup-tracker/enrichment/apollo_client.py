"""Apollo.io client (free plan). Best-effort: API access/limits depend on your plan.

  * search_people  -> finds decision makers at a domain (people search does NOT reveal emails)
  * match_person   -> enriches one person (name + domain) and returns the email (uses credits)

Every credit-consuming call is guarded by a persistent monthly budget.
"""
import logging
from dataclasses import dataclass

import httpx

from config import get_settings
from enrichment.rate_limit import AsyncRateLimiter, CreditBudget

log = logging.getLogger(__name__)
BASE = "https://api.apollo.io/api/v1"
DECISION_TITLES = ["CEO", "Founder", "Co-Founder", "CTO", "COO", "President", "Chief Executive Officer"]


@dataclass
class ApolloPerson:
    first_name: str
    last_name: str
    title: str | None = None
    email: str | None = None
    email_status: str | None = None
    linkedin_url: str | None = None
    apollo_id: str | None = None


class ApolloClient:
    def __init__(self) -> None:
        s = get_settings()
        self.enabled = bool(s.apollo_api_key)
        self.budget = CreditBudget("apollo", s.apollo_monthly_budget)
        self.limiter = AsyncRateLimiter(1.0)  # ~60 req/min is well within free limits
        self.client = httpx.AsyncClient(
            base_url=BASE, timeout=30,
            headers={"x-api-key": s.apollo_api_key, "Content-Type": "application/json",
                     "Cache-Control": "no-cache"},
        )

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _post(self, path: str, payload: dict) -> dict | None:
        await self.limiter.wait()
        try:
            resp = await self.client.post(path, json=payload)
        except httpx.HTTPError as exc:
            log.warning("Apollo %s failed: %s", path, exc)
            return None
        if resp.status_code == 429:
            log.warning("Apollo rate limit hit")
            return None
        if resp.status_code >= 400:
            log.warning("Apollo %s -> %s %s", path, resp.status_code, resp.text[:150])
            return None
        return resp.json()

    async def search_people(self, domain: str, limit: int = 3) -> list[ApolloPerson]:
        if not self.enabled:
            return []
        payload = {"q_organization_domains_list": [domain], "person_titles": DECISION_TITLES,
                   "page": 1, "per_page": limit}
        data = await self._post("/mixed_people/api_search", payload)
        if data is None:  # older endpoint name
            data = await self._post("/mixed_people/search", payload)
        people = []
        for p in (data or {}).get("people", []):
            first = p.get("first_name")
            last = p.get("last_name") or p.get("last_name_obfuscated") or ""
            if first:
                people.append(ApolloPerson(first, last, p.get("title"), p.get("email"),
                                           p.get("email_status"), p.get("linkedin_url"), p.get("id")))
        return people

    async def match_person(self, first: str, last: str, domain: str,
                           apollo_id: str | None = None) -> ApolloPerson | None:
        """Enrich a single person. Costs 1 credit."""
        if not self.enabled or not self.budget.spend(1):
            return None
        payload = {"first_name": first, "last_name": last, "domain": domain,
                   "reveal_personal_emails": False}
        if apollo_id:
            payload["id"] = apollo_id
        data = await self._post("/people/match", payload)
        p = (data or {}).get("person")
        if not p or not p.get("email") or "email_not_unlocked" in p["email"]:
            return None
        return ApolloPerson(p.get("first_name") or first, p.get("last_name") or last, p.get("title"),
                            p["email"], p.get("email_status"), p.get("linkedin_url"), p.get("id"))
