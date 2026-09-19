"""Small shared helpers: name normalisation, domain parsing, HTTP retry."""
import asyncio
import logging
import re
import unicodedata
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

_SUFFIXES = {
    "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
    "company", "plc", "gmbh", "pbc", "holdings", "lp", "llp",
}


def normalize_name(name: str) -> str:
    """'Acme Robotics, Inc.' -> 'acmerobotics' (used as a dedupe key)."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    words = [w for w in re.findall(r"[a-z0-9]+", s) if w not in _SUFFIXES]
    return "".join(words)


def extract_domain(url_or_host: str | None) -> str | None:
    """'https://www.acme.io/about' -> 'acme.io'."""
    if not url_or_host:
        return None
    s = url_or_host.strip().lower()
    if "//" not in s:
        s = "//" + s
    host = urlparse(s).hostname
    if not host or "." not in host:
        return None
    return host[4:] if host.startswith("www.") else host


async def get_with_retry(
    client: httpx.AsyncClient, url: str, *, retries: int = 3, **kwargs
) -> httpx.Response:
    """GET with exponential backoff on 429/5xx and transport errors."""
    delay = 1.0
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            resp = await client.get(url, **kwargs)
            if resp.status_code in (429, 500, 502, 503, 504):
                raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
            return resp
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            last_exc = exc
            log.warning("GET %s failed (%s), attempt %d/%d", url, exc, attempt + 1, retries)
            await asyncio.sleep(delay)
            delay *= 2
    assert last_exc is not None
    raise last_exc
