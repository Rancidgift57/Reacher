"""Rate limiting + persistent monthly credit budgets for free API tiers."""
import asyncio
from datetime import datetime, timezone

from sqlalchemy import select

from db import SessionLocal
from models.orm import ApiUsage


class AsyncRateLimiter:
    """Guarantees a minimum interval between calls (per instance)."""

    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def wait(self) -> None:
        async with self._lock:
            loop = asyncio.get_running_loop()
            gap = loop.time() - self._last
            if gap < self.min_interval:
                await asyncio.sleep(self.min_interval - gap)
            self._last = loop.time()


def _month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


class CreditBudget:
    """Monthly credit counter stored in the DB so it survives restarts."""

    def __init__(self, provider: str, monthly_limit: int):
        self.provider, self.limit = provider, monthly_limit

    def remaining(self) -> int:
        with SessionLocal() as s:
            row = s.scalar(select(ApiUsage).where(
                ApiUsage.provider == self.provider, ApiUsage.month == _month()))
            return self.limit - (row.count if row else 0)

    def spend(self, n: int = 1) -> bool:
        """Reserve n credits. Returns False (and spends nothing) if over budget."""
        with SessionLocal() as s:
            row = s.scalar(select(ApiUsage).where(
                ApiUsage.provider == self.provider, ApiUsage.month == _month()))
            if row is None:
                row = ApiUsage(provider=self.provider, month=_month(), count=0)
                s.add(row)
            if row.count + n > self.limit:
                return False
            row.count += n
            s.commit()
            return True
