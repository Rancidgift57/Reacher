"""Pydantic models: internal ingestion records + API response schemas."""
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


# ---------- Internal records produced by ingestion --------------------------
class RawPerson(BaseModel):
    first_name: str
    last_name: str
    title: str | None = None


class RawStartup(BaseModel):
    company_name: str
    source: str
    source_url: str | None = None
    cik: str | None = None
    domain: str | None = None
    filing_date: date | None = None
    amount_raised: float | None = None
    industry: str | None = None
    state: str | None = None
    people: list[RawPerson] = Field(default_factory=list)


# ---------- API schemas ------------------------------------------------------
class ContactOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    full_name: str | None
    title: str | None
    email: str | None
    email_status: str
    email_source: str | None
    linkedin_url: str | None = None


class StartupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    company_name: str
    company_domain: str | None
    cik: str | None
    source: str
    source_url: str | None
    filing_date: date | None
    amount_raised: float | None
    industry: str | None
    state: str | None
    enrichment_status: str
    created_at: datetime
    contacts: list[ContactOut] = []


class Page(BaseModel):
    items: list[StartupOut]
    total: int
    page: int
    page_size: int
    pages: int
