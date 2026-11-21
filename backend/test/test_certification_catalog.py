from app.data.certification_catalog import (
    CERTIFICATION_CATALOG, get_certification_url, missing_catalog_entries,
)
from app.controllers.analyze_controller import _shape_certifications


def test_every_certification_has_a_catalog_entry():
    assert missing_catalog_entries() == []


def test_urls_are_https():
    for key, entry in CERTIFICATION_CATALOG.items():
        if entry["url"]:
            assert entry["url"].startswith("https://"), key


def test_retired_certifications_have_no_link():
    assert get_certification_url("Azure Developer Associate") is None


def test_lookup_ignores_case():
    assert get_certification_url("AWS Certified Developer") == get_certification_url("aws certified developer")


def test_shaped_certifications_include_url():
    out = _shape_certifications([], {
        "target_job": "Cloud Engineer",
        "missing_certifications": ["aws certified developer"],
        "missing_optional_certifications": [],
    })
    assert out and "url" in out[0]