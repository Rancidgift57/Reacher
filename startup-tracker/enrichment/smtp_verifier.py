"""Free email verification: MX lookup (dnspython) + SMTP RCPT TO handshake.

No mail is ever sent. The verifier connects to the recipient's mail server,
says HELO / MAIL FROM / RCPT TO, reads the reply code and disconnects.

Honest limitations
  * Outbound port 25 is blocked by most residential ISPs and cloud hosts. In that
    case results come back as "unknown" and the pipeline falls back to guesses.
  * Catch-all domains accept every address -> we report "catch_all", not "valid".
  * Some providers (e.g. Microsoft 365) hide invalid mailboxes; results can be wrong.
"""
import asyncio
import logging
import smtplib
import socket
import uuid
from dataclasses import dataclass

import dns.asyncresolver
import dns.exception
import dns.resolver

from config import get_settings

log = logging.getLogger(__name__)
_BLOCK_HINTS = ("spamhaus", "blocked", "blacklist", "block list", "denied", "policy", "reputation", "rbl")


@dataclass
class VerifyResult:
    email: str
    status: str   # valid | invalid | catch_all | unknown
    detail: str = ""


async def get_mx_hosts(domain: str) -> list[str]:
    """MX hosts sorted by preference; falls back to the A record (RFC 5321). [] if none."""
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = 8
    try:
        answers = await resolver.resolve(domain, "MX")
        return [str(r.exchange).rstrip(".") for r in sorted(answers, key=lambda r: r.preference)]
    except (dns.resolver.NoAnswer,):
        try:
            await resolver.resolve(domain, "A")
            return [domain]
        except dns.exception.DNSException:
            return []
    except dns.exception.DNSException:
        return []


async def domain_accepts_mail(domain: str) -> bool:
    return bool(await get_mx_hosts(domain))


class SMTPVerifier:
    def __init__(self) -> None:
        self.s = get_settings()
        self._sem = asyncio.Semaphore(self.s.smtp_concurrency)
        self._mx: dict[str, list[str]] = {}
        self._catch_all: dict[str, bool | None] = {}
        self._unreachable: set[str] = set()

    # ---- blocking probe, executed in a worker thread ----------------------
    def _probe(self, host: str, email: str) -> tuple[int, str]:
        with smtplib.SMTP(timeout=self.s.smtp_timeout, local_hostname=self.s.smtp_helo_host) as smtp:
            smtp.connect(host, 25)
            smtp.ehlo_or_helo_if_needed()
            smtp.mail(self.s.smtp_mail_from)
            code, msg = smtp.rcpt(email)
            return code, msg.decode(errors="ignore") if isinstance(msg, bytes) else str(msg)

    async def _rcpt(self, host: str, email: str) -> tuple[int, str]:
        async with self._sem:
            return await asyncio.to_thread(self._probe, host, email)

    async def _mx_for(self, domain: str) -> list[str]:
        if domain not in self._mx:
            self._mx[domain] = await get_mx_hosts(domain)
        return self._mx[domain]

    async def is_catch_all(self, domain: str) -> bool | None:
        """True/False, or None if the domain can't be probed."""
        if domain in self._catch_all:
            return self._catch_all[domain]
        mx = await self._mx_for(domain)
        result: bool | None = None
        if mx and domain not in self._unreachable:
            probe = f"zz{uuid.uuid4().hex[:12]}@{domain}"
            try:
                code, _ = await self._rcpt(mx[0], probe)
                result = code in (250, 251)
            except (OSError, smtplib.SMTPException, socket.timeout) as exc:
                log.info("Port 25 probe failed for %s: %s", domain, exc)
                self._unreachable.add(domain)
        self._catch_all[domain] = result
        return result

    async def verify(self, email: str) -> VerifyResult:
        domain = email.rsplit("@", 1)[-1]
        mx = await self._mx_for(domain)
        if not mx:
            return VerifyResult(email, "invalid", "no MX/A record")
        if domain in self._unreachable:
            return VerifyResult(email, "unknown", "smtp unreachable")
        try:
            code, msg = await self._rcpt(mx[0], email)
        except (OSError, smtplib.SMTPException, socket.timeout) as exc:
            self._unreachable.add(domain)
            return VerifyResult(email, "unknown", f"smtp error: {exc}")

        lowered = msg.lower()
        if code in (250, 251):
            return VerifyResult(email, "valid", msg[:120])
        if 500 <= code < 600 and not any(h in lowered for h in _BLOCK_HINTS):
            return VerifyResult(email, "invalid", f"{code} {msg[:100]}")
        return VerifyResult(email, "unknown", f"{code} {msg[:100]}")  # greylist / blocked

    async def find_valid(self, candidates: list[str], domain: str) -> tuple[str | None, str]:
        """Return (email, status) for the first deliverable candidate.

        status: valid | catch_all | guessed | not_found
        """
        candidates = candidates[: self.s.smtp_max_candidates]
        if not candidates:
            return None, "not_found"
        if not self.s.smtp_verify_enabled:
            return candidates[0], "guessed"

        catch_all = await self.is_catch_all(domain)
        if catch_all is None:
            return candidates[0], "guessed"      # cannot probe -> best guess
        if catch_all:
            return candidates[0], "catch_all"    # server accepts everything

        for cand in candidates:
            res = await self.verify(cand)
            if res.status == "valid":
                return cand, "valid"
            if res.status == "unknown":          # greylisted / blocked mid-way
                return candidates[0], "guessed"
            await asyncio.sleep(0.3)
        return None, "not_found"
