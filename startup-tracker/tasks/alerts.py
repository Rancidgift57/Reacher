"""Discord / Slack / generic webhook delivery of newly processed startups."""
import logging
from datetime import date

import httpx

from config import get_settings
from models.orm import Startup

log = logging.getLogger(__name__)


def _money(v: float | None) -> str:
    if not v:
        return "undisclosed"
    if v >= 1e9:
        return f"${v / 1e9:.1f}B"
    if v >= 1e6:
        return f"${v / 1e6:.1f}M"
    return f"${v / 1e3:.0f}K"


def build_payload(startups: list[Startup]) -> dict:
    """Generic JSON digest (also the body sent to non-Discord/Slack webhooks)."""
    return {
        "date": date.today().isoformat(),
        "count": len(startups),
        "startups": [
            {
                "company": s.company_name,
                "domain": s.company_domain,
                "cik": s.cik,
                "source": s.source,
                "filing_date": s.filing_date.isoformat() if s.filing_date else None,
                "amount_raised": s.amount_raised,
                "url": s.source_url,
                "contacts": [
                    {"name": c.full_name, "title": c.title, "email": c.email, "status": c.email_status}
                    for c in s.contacts if c.email
                ],
            }
            for s in startups
        ],
    }


def _discord_bodies(payload: dict) -> list[dict]:
    embeds = []
    for st in payload["startups"]:
        lines = [f"**{c['name']}** ({c['title'] or 'n/a'})\n`{c['email']}` · {c['status']}" for c in st["contacts"][:4]]
        embeds.append({
            "title": f"{st['company']} — {_money(st['amount_raised'])}"[:250],
            "url": st["url"] or None,
            "description": ("\n".join(lines) or "_no contact found yet_")[:1800],
            "footer": {"text": f"{st['domain'] or 'no domain'} · {st['source']}"},
            "color": 0x0E5A5A,
        })
    bodies = []
    for i in range(0, len(embeds), 8):  # Discord: max 10 embeds and 6000 chars per message
        bodies.append({
            "content": f"**{payload['count']} new funded startups** ({payload['date']})" if i == 0 else None,
            "embeds": embeds[i:i + 8],
        })
    return bodies


def _slack_bodies(payload: dict) -> list[dict]:
    lines = []
    for st in payload["startups"]:
        head = f"*<{st['url']}|{st['company']}>*" if st["url"] else f"*{st['company']}*"
        lines.append(f"{head} — {_money(st['amount_raised'])} — {st['domain'] or 'no domain'}")
        for c in st["contacts"][:3]:
            lines.append(f"    • {c['name']} ({c['title'] or 'n/a'}): `{c['email']}` [{c['status']}]")
    header = f"*{payload['count']} new funded startups* ({payload['date']})"
    bodies, chunk = [], [header]
    for line in lines:
        if sum(len(x) for x in chunk) + len(line) > 2800:
            bodies.append({"text": "\n".join(chunk)})
            chunk = []
        chunk.append(line)
    bodies.append({"text": "\n".join(chunk)})
    return bodies


async def send_digest(startups: list[Startup]) -> bool:
    url = get_settings().webhook_url
    if not url or not startups:
        return False
    payload = build_payload(startups)
    if "discord" in url:
        bodies = _discord_bodies(payload)
    elif "slack" in url:
        bodies = _slack_bodies(payload)
    else:
        bodies = [payload]
    async with httpx.AsyncClient(timeout=20) as client:
        for body in bodies:
            resp = await client.post(url, json=body)
            if resp.status_code >= 300:
                log.error("Webhook failed: %s %s", resp.status_code, resp.text[:200])
                return False
    return True
