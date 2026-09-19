"""Offline tests (no network). Run:  pytest -q"""
import os

os.environ["DATABASE_URL"] = "sqlite:///./test_startups.db"
os.environ["SCHEDULER_MODE"] = "none"

import pytest
from fastapi.testclient import TestClient

from db import SessionLocal, engine, init_db
from enrichment.email_permutator import generate_candidates
from ingestion.rss_parser import parse_title
from ingestion.sec_edgar import parse_form_d
from models.orm import Base, Startup
from models.schemas import RawPerson, RawStartup
from tasks.pipeline import upsert_startup
from utils import extract_domain, normalize_name

FORM_D = """<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/formd">
 <primaryIssuer><cik>0001234567</cik><entityName>Acme Robotics, Inc.</entityName>
  <entityType>Corporation</entityType><issuerAddress><stateOrCountry>CA</stateOrCountry></issuerAddress></primaryIssuer>
 <relatedPersonsList>
  <relatedPersonInfo><relatedPersonName><firstName>jane</firstName><lastName>doe</lastName></relatedPersonName>
   <relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList>
   <relationshipClarification>CEO</relationshipClarification></relatedPersonInfo>
  <relatedPersonInfo><relatedPersonName><firstName>Big</firstName><lastName>Capital Fund LP</lastName></relatedPersonName>
   <relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList></relatedPersonInfo>
 </relatedPersonsList>
 <offeringData><industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup>
  <offeringSalesAmounts><totalOfferingAmount>5000000</totalOfferingAmount><totalAmountSold>3200000</totalAmountSold></offeringSalesAmounts></offeringData>
</edgarSubmission>"""


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    init_db()
    yield


def test_parse_form_d():
    d = parse_form_d(FORM_D)
    assert d["name"] == "Acme Robotics, Inc." and d["amount"] == 3_200_000
    assert [(p.first_name, p.last_name, p.title) for p in d["people"]] == [("Jane", "Doe", "CEO")]


def test_rss_title():
    assert parse_title("Acme Robotics raises $12M Series A to build robots") == ("Acme Robotics", 12_000_000)
    assert parse_title("The weekly newsletter roundup") is None


def test_permutations_and_utils():
    assert generate_candidates("Jane", "Doe", "acme.io")[:3] == ["jane.doe@acme.io", "jane@acme.io", "jdoe@acme.io"]
    assert normalize_name("Acme Robotics, Inc.") == "acmerobotics"
    assert extract_domain("https://www.Acme.io/about") == "acme.io"


def test_dedup_merges_sources():
    with SessionLocal() as s:
        a, created_a = upsert_startup(s, RawStartup(company_name="Acme Robotics, Inc.", source="sec_form_d",
                                                    cik="0001234567", people=[RawPerson(first_name="Jane", last_name="Doe", title="CEO")]))
        b, created_b = upsert_startup(s, RawStartup(company_name="Acme Robotics", source="rss", amount_raised=12e6))
        c, created_c = upsert_startup(s, RawStartup(company_name="Acme Robotics Inc", source="rss"))
        assert created_a and not created_b and not created_c
        assert a.id == b.id == c.id and b.amount_raised == 12e6 and len(b.contacts) == 1
        assert s.query(Startup).count() == 1


def test_api():
    with SessionLocal() as s:
        upsert_startup(s, RawStartup(company_name="Beta Labs", source="rss", amount_raised=1e6))
    client = TestClient(__import__("main").app)
    body = client.get("/api/startups?page_size=10").json()
    assert body["total"] == 1 and body["items"][0]["company_name"] == "Beta Labs"
    assert client.get("/api/stats").json()["startups"] == 1
    assert client.get("/api/startups?since=2020-01-01&q=beta").json()["total"] == 1
    assert client.get("/").status_code == 200


@pytest.mark.asyncio
async def test_enrichment_flow(monkeypatch):
    import tasks.pipeline as pl
    from tasks.alerts import build_payload, _discord_bodies, _slack_bodies

    async def fake_resolve(name):
        return "acme.io", "duckduckgo"

    async def fake_find_valid(self, cands, domain):
        return cands[0], "valid"

    monkeypatch.setattr(pl, "resolve_domain", fake_resolve)
    monkeypatch.setattr(pl.SMTPVerifier, "find_valid", fake_find_valid)

    with SessionLocal() as s:
        st, _ = upsert_startup(s, RawStartup(company_name="Acme Robotics", source="sec_form_d", cik="0001234567",
                                             people=[RawPerson(first_name="Jane", last_name="Doe", title="CEO")]))
        sid = st.id
    enricher = pl.Enricher()
    await enricher.enrich(sid)
    await enricher.aclose()
    with SessionLocal() as s:
        st = s.get(Startup, sid)
        assert st.enrichment_status == "done" and st.company_domain == "acme.io"
        assert st.contacts[0].email == "jane.doe@acme.io" and st.contacts[0].email_status == "valid"
        payload = build_payload([st])
    assert payload["startups"][0]["contacts"][0]["email"] == "jane.doe@acme.io"
    assert _discord_bodies(payload)[0]["embeds"] and "jane.doe@acme.io" in _slack_bodies(payload)[0]["text"]
