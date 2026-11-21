# FILE LOCATION: scripts/check_certification_links.py
# Run from the backend root:  python -m scripts.check_certification_links
# Reports catalog URLs that do not answer with a 2xx/3xx status, and any
# certification in job_requirements.py that has no catalog entry.
import urllib.request

from app.data.certification_catalog import CERTIFICATION_CATALOG, missing_catalog_entries

HEADERS = {"User-Agent": "Mozilla/5.0 (Aura link checker)"}


def check(url: str) -> str:
    for method in ("HEAD", "GET"):  # some sites reject HEAD
        try:
            req = urllib.request.Request(url, method=method, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=15) as resp:
                return str(resp.status)
        except Exception as exc:  # noqa: BLE001
            last = getattr(exc, "code", type(exc).__name__)
    return f"FAIL ({last})"


if __name__ == "__main__":
    missing = missing_catalog_entries()
    print("Missing catalog entries:", missing or "none")
    for key, entry in sorted(CERTIFICATION_CATALOG.items()):
        if entry["status"] == "retired" or not entry["url"]:
            print(f"[retired] {key}: {entry['note']}")
            continue
        print(f"[{check(entry['url'])}] {key}  {entry['url']}")