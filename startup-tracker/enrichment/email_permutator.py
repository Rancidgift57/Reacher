"""Generate likely email addresses for a person at a domain."""
import re
import unicodedata


def _clean(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


# Ordered by how common they are in startups (first.last and first dominate).
_PATTERNS = [
    "{first}.{last}", "{first}", "{f}{last}", "{first}{last}", "{first}{l}",
    "{f}.{last}", "{first}_{last}", "{last}", "{last}.{first}", "{first}-{last}",
]
GENERIC_LOCALS = ["ceo", "founders", "founder", "hello", "contact", "team", "info"]


def generate_candidates(first: str, last: str, domain: str) -> list[str]:
    f, l = _clean(first), _clean(last)
    if not f or not l:
        return []
    seen: list[str] = []
    for p in _PATTERNS:
        local = p.format(first=f, last=l, f=f[0], l=l[0])
        addr = f"{local}@{domain}"
        if addr not in seen:
            seen.append(addr)
    return seen


def generic_candidates(domain: str) -> list[str]:
    return [f"{local}@{domain}" for local in GENERIC_LOCALS]
