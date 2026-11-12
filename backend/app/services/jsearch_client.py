# app/services/jsearch_client.py
"""
JSearch API client (via RapidAPI) for fetching job listings.
Endpoint: /search-v2

Freelance & internship support
------------------------------
JSearch has no native "freelance" employment type (it only reports
FULLTIME / PARTTIME / CONTRACTOR / INTERN), so freelance output is built from
four pieces:
  1. _parse_job() labels a posting "Freelance" via posting_classifier's
     classify_job_type(): "freelance" in the title, or a CONTRACTOR posting
     whose description calls it freelance. A full-time/part-time posting that
     merely mentions freelancers in passing is NOT relabelled.
  2. fetch_jobs(..., internship_only=True) is the "Internships only" mode: it
     biases every query with the word "internship" and drops anything not
     labelled "Internship" (INTERN or "intern" in the title).
  3. fetch_jobs(..., include_freelance=True) keeps the normal queries and adds
     ONE extra freelance-biased query, keeping only "Freelance" postings from
     it. This is what makes the dashboard's Freelance filter have results
     without switching the whole search to freelance-only.
"""

import os
import re
import time
import threading
import logging
import urllib.request
import urllib.parse
import urllib.error
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import List, Optional

from app.services.posting_classifier import (
    classify_experience_level,
    classify_job_type,
    classify_target_job,
)

# Shared "aura" logger (same one main.py / analyze_controller use). A bare
# logging.getLogger(__name__) here had no handler, so INFO lines were dropped.
from app.utils.logger import logger

JSEARCH_BASE_URL = "https://jsearch.p.rapidapi.com/search-v2"
DEFAULT_RESULTS  = 10
MAX_KEYWORDS     = 5

# search-v2's `country` param defaults to "us" server-side whenever it's
# omitted (per JSearch docs: "this parameter must be set in order to get
# jobs in a specific country"). Previously this client never sent it and
# instead appended "Philippines"/"Remote Philippines" as plain text onto
# the query string, hoping Google-for-Jobs' free-text parser would infer
# location from that. It doesn't override the server-side country filter
# — every request was silently being scoped to US jobs regardless of the
# text hint, which is why match quality/coverage looked bad. `country`
# below is sent as an explicit request param instead (ISO 3166-1 alpha-2).
COUNTRY_CODE = "ph"

# Keys under which the actual job array might be nested if
# JSearch returns "data" as an object instead of a bare list.
# (search-v2 has been observed to wrap results this way for
# some queries/plans, unlike the plain /search endpoint.)
_NESTED_LIST_KEYS = ("jobs", "results", "data", "items")

def _job_type_from_api(raw: dict) -> Optional[str]:
    """
    Reads the employment type JSearch itself reports for a posting and maps it
    to the five values the dashboard filters on. JSearch sends it as
    `job_employment_types` (list), `job_employment_type` (single value) and
    sometimes `job_employment_type_text` — e.g. "FULLTIME", "PARTTIME",
    "CONTRACTOR", "INTERN". Returns None when none of them map to one of the
    five values, so the caller can fall back to classifying the posting text.
    """
    candidates: list = []
    listed = raw.get("job_employment_types")
    if isinstance(listed, list):
        candidates.extend(listed)
    candidates.append(raw.get("job_employment_type"))
    candidates.append(raw.get("job_employment_type_text"))

    for value in candidates:
        if not isinstance(value, str):
            continue
        text = "".join(ch for ch in value.lower() if ch.isalpha())
        if "fulltime" in text:
            return "Full-time"
        if "parttime" in text:
            return "Part-time"
        if "contract" in text:
            return "Contractual"
        if "freelance" in text:
            return "Freelance"
        if text.startswith("intern"):  # "intern", "internship"; not "international"
            return "Internship"
    return None


@dataclass
class JobListing:
    job_id:           str
    title:            str
    company:          str
    location:         str
    description:      str
    salary_min:       Optional[float]
    salary_max:       Optional[float]
    url:              str
    category:         str
    keywords_matched: List[str] = field(default_factory=list)
    # The three values the dashboard filters on, each read off the posting
    # itself by app/services/posting_classifier.py. All are None when the
    # posting gives no usable signal (never a guess):
    #   experience_level - "Entry-Level" | "Junior Level" | "Mid-Level" | "Senior"
    #   job_type         - "Full-time" | "Part-time" | "Contractual" | "Freelance" | "Internship"
    #   target_job       - one of the 20 roles in job_requirements.py
    experience_level: Optional[str] = None
    job_type:         Optional[str] = None
    target_job:       Optional[str] = None


class JSearchClient:

    # ── Rate limiting ─────────────────────────────────────────────
    # fetch_jobs() fires up to `max_keywords` queries concurrently via a
    # thread pool, which used to mean every /api/analyze call sent a
    # burst of simultaneous requests to RapidAPI — reliably tripping its
    # per-second rate limit and coming back as HTTP 429 for every query,
    # every time. These are class-level (shared across threads/instances
    # within a process) so the burst gets spaced out instead of firing
    # all at once, and a 429 gets retried with backoff instead of just
    # being dropped.
    _rate_lock = threading.Lock()
    _last_request_time = 0.0
    _MIN_REQUEST_INTERVAL = 0.5  # seconds between outgoing requests
    _MAX_RETRIES = 2
    _BASE_BACKOFF = 1.5  # seconds, doubled per retry attempt

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("JSEARCH_API_KEY", "")
        if not self.api_key:
            raise ValueError("JSEARCH_API_KEY is not set.")

    @classmethod
    def _throttle(cls):
        """Block just long enough to keep requests spaced out, even
        when called concurrently from multiple threads."""
        with cls._rate_lock:
            now = time.monotonic()
            wait = cls._last_request_time + cls._MIN_REQUEST_INTERVAL - now
            if wait > 0:
                time.sleep(wait)
            cls._last_request_time = time.monotonic()

    def _get(self, query: str, work_from_home: bool = False) -> list:
        params = urllib.parse.urlencode({
            "query":          query,
            "num_pages":      "1",
            "date_posted":    "all",
            "country":        COUNTRY_CODE,
            "work_from_home": "true" if work_from_home else "false",
        })
        url = f"{JSEARCH_BASE_URL}?{params}"
        logger.debug("GET %s", url)

        req = urllib.request.Request(url, headers={
            "Content-Type":    "application/json",
            "x-rapidapi-key":  self.api_key,
            "x-rapidapi-host": "jsearch.p.rapidapi.com",
        })

        for attempt in range(self._MAX_RETRIES + 1):
            self._throttle()
            try:
                # 30s timeout — JSearch can be slow from Southeast Asia
                with urllib.request.urlopen(req, timeout=30) as resp:
                    payload = json.loads(resp.read().decode())
                    return self._extract_job_list(payload, query)
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < self._MAX_RETRIES:
                    retry_after = e.headers.get("Retry-After") if e.headers else None
                    delay = float(retry_after) if retry_after else self._BASE_BACKOFF * (2 ** attempt)
                    logger.warning(
                        "JSearch rate-limited for '%s' — retrying in %.1fs (attempt %d/%d)",
                        query, delay, attempt + 1, self._MAX_RETRIES,
                    )
                    time.sleep(delay)
                    continue
                # Log RapidAPI's own explanation (monthly quota vs. per-second
                # limit vs. bad key) - the bare "HTTP Error 429" doesn't say.
                try:
                    body = e.read().decode("utf-8", "replace")[:300]
                except Exception:
                    body = ""
                logger.warning("JSearch HTTP %s for '%s': %s", e.code, query, body)
                raise

        return []

    @staticmethod
    def _extract_job_list(payload: dict, query: str) -> list:
        """
        Normalizes the JSearch response into a plain list of job dicts.

        search-v2 has been observed to return `data` as either:
          - a bare list of job dicts (the expected/original shape), or
          - a dict wrapping the actual list under a key like
            "jobs" / "results" / "data" / "items".

        Indexing a dict with a slice (e.g. some_dict[:10]) raises
        `KeyError: slice(...)` on Python 3.12+ rather than a TypeError,
        which is what originally surfaced as a 500 here — so we
        defensively unwrap before returning.
        """
        if not isinstance(payload, dict):
            logger.warning(
                "JSearch response for '%s' was not a dict (got %s) — skipping.",
                query, type(payload).__name__,
            )
            return []

        result = payload.get("data", [])

        if isinstance(result, list):
            return result

        if isinstance(result, dict):
            logger.warning(
                "JSearch 'data' for '%s' was a dict, not a list. Keys: %s",
                query, list(result.keys()),
            )
            for key in _NESTED_LIST_KEYS:
                nested = result.get(key)
                if isinstance(nested, list):
                    logger.info(
                        "Recovered job list for '%s' from nested key '%s'.",
                        query, key,
                    )
                    return nested
            logger.warning(
                "Could not locate a job list inside 'data' for '%s' — returning empty.",
                query,
            )
            return []

        logger.warning(
            "JSearch 'data' for '%s' was type %s — expected list or dict. Returning empty.",
            query, type(result).__name__,
        )
        return []

    @staticmethod
    def _parse_job(raw: dict, keyword: str) -> JobListing:
        city     = raw.get("job_city") or ""
        state    = raw.get("job_state") or ""
        country  = raw.get("job_country") or ""
        location = ", ".join(filter(None, [city, state, country])) or "Philippines"

        salary_min = raw.get("job_min_salary")
        salary_max = raw.get("job_max_salary")
        url = raw.get("job_apply_link") or raw.get("job_google_link") or ""
        title = raw.get("job_title", "").strip()

        # JSearch has no "freelance" employment type (a freelance gig usually
        # comes tagged CONTRACTOR). classify_job_type() reads the full raw
        # posting (the description below is cut to 500 chars) and decides
        # Freelance vs Contractual vs Full/Part-time; the API-reported type is
        # only the fallback when the classifier finds nothing.
        api_type = _job_type_from_api(raw)
        if api_type == "Freelance":
            job_type = "Freelance"
        else:
            job_type = classify_job_type(raw, title) or api_type

        return JobListing(
            job_id      = raw.get("job_id", ""),
            title       = title,
            company     = raw.get("employer_name", "Unknown").strip(),
            location    = location,
            description = (raw.get("job_description") or "")[:500].strip(),
            salary_min  = float(salary_min) if salary_min else None,
            salary_max  = float(salary_max) if salary_max else None,
            url         = url,
            # Kept for older callers; now the normalized job type instead of a
            # blanket "Full-time" default, so listings with no stated type are
            # not mislabelled.
            category    = job_type or "Not specified",
            keywords_matched  = [keyword],
            experience_level  = classify_experience_level(raw, title),
            job_type          = job_type,
            target_job        = classify_target_job(title),
        )

    def fetch_jobs(
        self,
        keywords:            List[str],
        results_per_keyword: int = DEFAULT_RESULTS,
        max_keywords:        int = MAX_KEYWORDS,
        internship_only:     bool = False,
        include_freelance:   bool = False,
        freelance_keyword:   Optional[str] = None,
    ) -> List[JobListing]:
        """
        Queries JSearch for each keyword, scoped to COUNTRY_CODE via the
        API's own `country` param (see the note on COUNTRY_CODE above —
        this used to be attempted via a text suffix on the query, which
        didn't actually filter anything). Alternates each keyword between
        an on-site/hybrid search and a `work_from_home=true` search so we
        get both local and remote-eligible results per keyword, instead
        of burning a second full query slot per keyword the way the old
        text-suffix rotation did.

        internship_only=True prefixes each query with "internship" and returns
        only postings labelled "Internship" (see _parse_job). Default False
        leaves existing callers unchanged.

        include_freelance=True (ignored when internship_only=True) keeps the
        normal queries and adds one extra "freelance <top keyword>" query,
        remote-eligible, from which only "Freelance" postings are kept. Costs
        one additional JSearch request per call. freelance_keyword picks what
        that query searches for (e.g. the target role); default is the first
        keyword.
        """
        seen: dict[str, JobListing] = {}
        top_kw = keywords[:max_keywords]

        # Each keyword hits JSearch as a separate blocking HTTP call (up to
        # 30s each per the timeout in _get()). Running these one-after-
        # another in a for-loop meant /api/analyze could take 5x a single
        # call's latency (we saw 18-28s end-to-end in practice) — the
        # frontend's "rendering" step wasn't slow, it was just still
        # waiting on this loop to finish. Firing all requests at once via
        # a thread pool collapses that to roughly the slowest single call.
        # Each entry: (keyword, query text, work_from_home, keep_only_type);
        # keep_only_type is None (keep everything) or a job_type label.
        normal_only = "Internship" if internship_only else None
        queries = [
            (kw, f"internship {kw}" if internship_only else kw, i % 2 == 1, normal_only)  # alternate: on-site, remote, ...
            for i, kw in enumerate(top_kw)
        ]

        # Extra freelance-biased query alongside the normal ones. Freelance
        # work is mostly remote, so it runs with work_from_home on.
        if include_freelance and not internship_only and top_kw:
            fk = (freelance_keyword or "").strip() or top_kw[0]
            queries.append((fk, f"freelance {fk}", True, "Freelance"))

        with ThreadPoolExecutor(max_workers=max(1, len(queries))) as pool:
            future_to_kw = {
                pool.submit(self._get, query, wfh): (kw, keep_type)
                for kw, query, wfh, keep_type in queries
            }

            for future in as_completed(future_to_kw):
                kw, keep_type = future_to_kw[future]
                logger.info("Querying JSearch: '%s'%s", kw, f" [{keep_type.lower()}]" if keep_type else "")
                try:
                    results = future.result()
                except Exception as exc:
                    logger.warning("JSearch query failed for '%s': %s", kw, exc)
                    continue

                if not isinstance(results, list):
                    # Belt-and-suspenders: _get should already guarantee a list,
                    # but never let a bad shape crash the whole request.
                    logger.warning(
                        "Unexpected results type for '%s': %s — skipping.",
                        kw, type(results).__name__,
                    )
                    continue

                if keep_type:
                    sample = [
                        f"{str(r.get('job_title') or '')[:45]} "
                        f"[{r.get('job_employment_type') or r.get('job_employment_types') or '?'}]"
                        for r in results[:results_per_keyword] if isinstance(r, dict)
                    ]
                    logger.info(
                        "%s query '%s' returned %d raw posting(s): %s",
                        keep_type, kw, len(results), "; ".join(sample[:6]) or "none",
                    )

                for raw in results[:results_per_keyword]:
                    if not isinstance(raw, dict):
                        logger.warning("Skipping non-dict job entry for '%s': %r", kw, raw)
                        continue
                    jid = raw.get("job_id", "")
                    if jid in seen:
                        if kw not in seen[jid].keywords_matched:
                            seen[jid].keywords_matched.append(kw)
                    else:
                        job = self._parse_job(raw, kw)
                        if keep_type and job.job_type != keep_type:
                            continue
                        seen[jid] = job

        jobs = list(seen.values())
        logger.info(
            "Fetched %d unique %sjobs from JSearch (%d labelled Freelance, %d labelled Internship)",
            len(jobs), "internship " if internship_only else "",
            sum(1 for j in jobs if j.job_type == "Freelance"),
            sum(1 for j in jobs if j.job_type == "Internship"),
        )
        return jobs