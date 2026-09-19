"""Hunter.io client (free plan ~50 credits/month). Guarded by a persistent budget."""
import logging
from dataclasses import dataclass

import httpx

from config import get_settings
from enrichment.rate_limit import AsyncRateLimiter, CreditBudget

log = logging.getLogger(__name__)
BASE = "https://api.hunter.io/v2"


@dataclass
class HunterPerson:
    first_name: str
    last_name: str
    title: str | None
    email: str
    confidence: int | None


class HunterClient:
    def __init__(self) -> None:
        s = get_settings()
        self.key = s.hunter_api_key
        self.enabled = bool(self.key)
        self.budget = CreditBudget("hunter", s.hunter_monthly_budget)
        self.limiter = AsyncRateLimiter(1.0)
        self.client = httpx.AsyncClient(base_url=BASE, timeout=30)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def domain_search(self, domain: str, limit: int = 5) -> list[HunterPerson]:
        if not self.enabled or not self.budget.spend(1):
            return []
        await self.limiter.wait()
        try:
            resp = await self.client.get("/domain-search", params={
                "domain": domain, "limit": limit, "type": "personal",
                "seniority": "senior,executive", "api_key": self.key})
        except httpx.HTTPError as exc:
            log.warning("Hunter domain-search failed: %s", exc)
            return []
        if resp.status_code != 200:
            log.warning("Hunter -> %s %s", resp.status_code, resp.text[:150])
            return []
        out = []
        for e in resp.json().get("data", {}).get("emails", []):
            if e.get("value") and e.get("first_name"):
                out.append(HunterPerson(e["first_name"], e.get("last_name") or "", e.get("position"),
                                        e["value"], e.get("confidence")))
        return out

    async def email_finder(self, domain: str, first: str, last: str) -> HunterPerson | None:
        if not self.enabled or not self.budget.spend(1):
            return None
        await self.limiter.wait()
        try:
            resp = await self.client.get("/email-finder", params={
                "domain": domain, "first_name": first, "last_name": last, "api_key": self.key})
        except httpx.HTTPError:
            return None
        data = resp.json().get("data", {}) if resp.status_code == 200 else {}
        if not data.get("email"):
            return None
        return HunterPerson(first, last, data.get("position"), data["email"], data.get("score"))
