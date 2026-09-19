"""SQLAlchemy 2.0 models.

Deduplication is enforced by the database itself through UNIQUE constraints on
`cik`, `company_domain` and `name_key` (NULLs are allowed and never collide).
"""
from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Startup(Base):
    __tablename__ = "startups"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_name: Mapped[str] = mapped_column(String(300))
    name_key: Mapped[str] = mapped_column(String(300), unique=True, index=True)
    cik: Mapped[str | None] = mapped_column(String(10), unique=True, nullable=True)
    company_domain: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    domain_source: Mapped[str | None] = mapped_column(String(30))
    source: Mapped[str] = mapped_column(String(50))          # sec_form_d | rss | yc
    source_url: Mapped[str | None] = mapped_column(Text)
    filing_date: Mapped[date | None] = mapped_column(Date)
    amount_raised: Mapped[float | None] = mapped_column(Float)  # USD
    industry: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(50))
    # pending | done | no_domain | duplicate | failed
    enrichment_status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    enriched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    alerted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    contacts: Mapped[list["Contact"]] = relationship(
        back_populates="startup", cascade="all, delete-orphan", lazy="selectin"
    )


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (UniqueConstraint("startup_id", "email", name="uq_contact_startup_email"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    startup_id: Mapped[int] = mapped_column(ForeignKey("startups.id", ondelete="CASCADE"), index=True)
    first_name: Mapped[str | None] = mapped_column(String(100))
    last_name: Mapped[str | None] = mapped_column(String(100))
    full_name: Mapped[str | None] = mapped_column(String(200))
    title: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(320))
    # valid | catch_all | guessed | apollo | hunter | unverified | not_found
    email_status: Mapped[str] = mapped_column(String(20), default="unverified")
    email_source: Mapped[str | None] = mapped_column(String(30))  # form_d|apollo|hunter|permutation|generic
    linkedin_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    startup: Mapped[Startup] = relationship(back_populates="contacts")


class ApiUsage(Base):
    """Tracks monthly credit spend so free tiers are never exceeded."""

    __tablename__ = "api_usage"
    __table_args__ = (UniqueConstraint("provider", "month", name="uq_usage_provider_month"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(30))
    month: Mapped[str] = mapped_column(String(7))  # YYYY-MM
    count: Mapped[int] = mapped_column(Integer, default=0)
