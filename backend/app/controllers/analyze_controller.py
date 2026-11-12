# ==============================================================================
# FILE LOCATION: app/controllers/analyze_controller.py
# ==============================================================================
#
# PURPOSE:
#   Coordinates the complete /api/analyze workflow (IT-field only — a non-IT
#   target_job is rejected with 422 in STEP 1.5):
#
#       Upload
#          ↓
#       Resume Parser
#          ↓
#       JobMatcher / JSearch
#          ↓
#       Target Job Gap
#          ↓
#       Job-Posting Text Selection (pasted JD -> matched job -> none)
#          ↓
#       Resume Enrichment (skill_gaps: job-posting comparison, else backup)
#          ↓
#       Supabase
#          ↓
#       Frontend JSON
#
#   Important:
#   This controller does NOT invent job/company metadata.
#   Location, job type, experience, salary, and team size are taken from the
#   data available on the matched/raw job objects.
#
# THIS REVISION:
#   _shape_top_jobs() now also copies matched_keywords, semantic_similarity,
#   and a score_breakdown (keyword/skills/semantic/api_match/title) onto
#   each shaped job. These were already computed on ScoredJob (job_scorer.py's
#   hybrid semantic scoring) but were previously dropped at this dict-shaping
#   boundary — only total_score and matched_skills made it to the frontend.
#   Added job-posting-text selection for skill-gap comparison, per the
#   original spec ("AURA should analyze the actual job posting... Matched
#   / Missing"), with a clear priority order:
#     1. The single best-matching real job listing from JSearch
#        (result.top_jobs[0]'s FULL, untruncated description — NOT the
#        500-char-truncated version in top_jobs_shaped, which is
#        display-only).
#     2. Otherwise (JSearch returned nothing — rate-limited, no matches,
#        etc.), no job-posting text is passed to enrich_resume_local at
#        all, and it falls back internally to the pre-existing hardcoded
#        taxonomy (job_requirements.py / SKILL_TAXONOMY) — the "backup
#        result".
#   Note: the user's pasted job_description still steers job matching
#   itself (JobMatcher/JobScorer), it just isn't a skill-gap comparison
#   source on its own.
#   See resume_enricher.py's enrich_resume_local() / _detect_skill_gaps_from_posting()
#   docstrings for the comparison logic itself.
#
#   Also: certification_engine.recommend_certifications() was implemented but
#   never called from here — `certifications` was permanently absent from the
#   API response. _shape_certifications() (STEP 8.5) now calls it against the
#   missing skills from enrichment["skill_gaps"] and adds the result to the
#   final response.
# ==============================================================================

"""
Coordinates the /api/analyze flow.
"""

import json
import os
import re
from typing import Any

from fastapi import HTTPException, UploadFile

from app.extensions.supabase_client import supabase_admin
from app.services.resume_parser import parse_resume
from app.services.job_matcher import JobMatcher
# Reused here (not just in jsearch_client.py's own parsing step) so a raw
# JSearch dict reaching this controller directly — the "company not in
# top_jobs_shaped, fall back to raw_jobs" branch below — gets the exact
# same job_required_experience interpretation + title-guess fallback,
# instead of a second, weaker copy of that logic.
from app.services.posting_classifier import classify_experience_level
from app.services.resume_enricher import enrich_resume_local
from app.services.target_job_matcher import calculate_target_job_gap
from app.data.it_domain import is_it_title, canonical_it_title
from app.data.job_requirements import JOB_REQUIREMENTS

# Most job titles a user may select at once (mirrors JobTitleSelector's maxSelections).
MAX_TARGET_JOBS = 3
from app.utils.logger import logger


# ==============================================================================
# ALLOWED RESUME FILE TYPES
# ==============================================================================

ALLOWED_RESUME_MIME_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


# ==============================================================================
# GENERIC ATTRIBUTE HELPER
# ==============================================================================

def _get_attr(
    obj: Any,
    *names: str,
    default: Any = None,
) -> Any:
    """
    Safely retrieves the first available attribute from an object.

    This makes the controller tolerant of slightly different field names
    between the JobListing model and JSearch's API naming.
    """

    if obj is None:
        return default

    for name in names:

        try:
            value = getattr(obj, name, None)
        except Exception:
            value = None

        if value is not None:
            return value

    # Also support dictionaries if a raw dictionary reaches this layer.
    if isinstance(obj, dict):

        for name in names:

            if name in obj and obj[name] is not None:
                return obj[name]

    return default


# ==============================================================================
# STRING CLEANER
# ==============================================================================

def _clean_string(
    value: Any,
    default: str = "",
) -> str:
    """
    Converts a value into a clean display string.
    """

    if value is None:
        return default

    # Handle dictionaries separately because str(dict) is not useful
    # for frontend display.
    if isinstance(value, dict):

        # Common experience-level fields.
        for key in (
            "name",
            "level",
            "value",
            "title",
            "label",
        ):

            nested = value.get(key)

            if nested:
                return str(nested).strip()

        return default

    text = str(value).strip()

    return text if text else default


# ==============================================================================
# LOCATION FORMATTER
# ==============================================================================

def _format_location(job: Any) -> str:
    """
    Builds the most specific location available from the API.

    Example:
        Makati City, Metro Manila, Philippines
    """

    # First use an already-formatted location if the JobListing model has one.
    formatted = _get_attr(
        job,
        "location",
        "job_location",
        "formatted_location",
        "location_name",
        default=None,
    )

    # Extract individual geographic fields.
    city = _clean_string(
        _get_attr(
            job,
            "city",
            "job_city",
            "location_city",
        )
    )

    state = _clean_string(
        _get_attr(
            job,
            "state",
            "job_state",
            "location_state",
            "province",
            "region",
        )
    )

    country = _clean_string(
        _get_attr(
            job,
            "country",
            "job_country",
            "location_country",
        )
    )

    # Prefer the explicit API components when available.
    components = []

    if city:
        components.append(city)

    if state and state.lower() not in {
        city.lower(),
    }:
        components.append(state)

    if country and country.lower() not in {
        city.lower(),
        state.lower(),
    }:
        components.append(country)

    if components:
        return ", ".join(components)

    # Fall back to the model's existing formatted location.
    if formatted:
        return _clean_string(
            formatted,
            default="Location not disclosed",
        )

    # Do NOT invent "Philippines".
    return "Location not disclosed"


# ==============================================================================
# JOB TYPE
# ==============================================================================

def _get_job_type(job: Any) -> str:
    """
    Retrieves the employment/job type supplied by the API.
    """

    value = _get_attr(
        job,
        "job_type",
        "job_employment_type",
        "employment_type",
        "employmentType",
        "jobType",
        # "category" is where jsearch_client.py's JobListing dataclass
        # actually stores this (JobListing has no field literally named
        # any of the JSearch-style names above) — without checking it,
        # every job reaching this function as a structured JobListing
        # object (rather than a raw API dict) fell straight through to
        # the "not disclosed" default, even though jsearch_client.py had
        # already captured the real value from job_employment_type.
        "category",
        "type",
        default=None,
    )

    return _clean_string(
        value,
        default="Job type not disclosed",
    )


# ==============================================================================
# EXPERIENCE LEVEL
# ==============================================================================

def _get_experience_level(job: Any) -> str:
    """
    Retrieves the experience/seniority level supplied by the API.

    NOTE: this only finds anything now that jsearch_client.py's
    JobListing dataclass actually carries an `experience_level` field
    (populated by _infer_experience_level(), which reads JSearch's
    structured job_required_experience data and falls back to a
    title-based guess). Before that field existed, `job` — a JobListing
    instance, not a raw API dict — had no attribute under any of the
    names below, so this always fell through to the default.
    """

    value = _get_attr(
        job,
        "experience_level",
        "job_experience_level",
        "job_required_experience",
        "job_experience_in_place",
        "experienceLevel",
        "experience",
        "seniority",
        default=None,
    )

    # JSearch's own `job_required_experience` field, when a raw API dict
    # reaches this function directly (the raw_jobs fallback branch below,
    # for a company that didn't show up in top_jobs_shaped), is a nested
    # object — e.g. {"required_experience_in_months": 24,
    # "no_experience_required": false, ...} — not a plain string. The
    # generic dict handling in _clean_string() only recognizes
    # "name"/"level"/"value"/"title"/"label" keys, none of which JSearch
    # actually uses here, so it was silently falling straight to the
    # "not disclosed" default. Recognize that specific shape and
    # interpret it the same way jsearch_client.py does when building a
    # JobListing, instead of duplicating weaker logic here.
    if isinstance(value, dict) and (
        "required_experience_in_months" in value
        or "no_experience_required" in value
        or "experience_mentioned" in value
    ):
        title = _clean_string(_get_attr(job, "title", "job_title"))
        inferred = classify_experience_level({"job_required_experience": value}, title)
        value = inferred  # may still be None -> falls through to the title-only guess below

    if value is None:
        # Nothing structured at all (older cached payloads, or a raw
        # dict/object with no experience-shaped field whatsoever) — same
        # title-based guess jsearch_client.py applies when building
        # JobListing objects, applied here too so this function behaves
        # consistently regardless of which shape of job reaches it.
        title = _clean_string(_get_attr(job, "title", "job_title"))
        value = classify_experience_level({}, title)

    return _clean_string(
        value,
        default="Experience level not disclosed",
    )


# ==============================================================================
# TEAM SIZE
# ==============================================================================

def _get_team_size(job: Any) -> str:
    """
    Retrieves company/team size when the API/model provides it.

    We intentionally DO NOT invent a company size.
    """

    value = _get_attr(
        job,
        "team_size",
        "company_size",
        "employer_company_size",
        "employer_size",
        "teamSize",
        "companySize",
        default=None,
    )

    # Some APIs/models may expose employee count directly.
    if value is None:

        value = _get_attr(
            job,
            "employee_count",
            "company_employee_count",
            "employer_employee_count",
            "employees",
            default=None,
        )

    if value is None:
        return "Team size not disclosed"

    # Handle dictionaries such as:
    # {"min": 51, "max": 200}
    if isinstance(value, dict):

        minimum = (
            value.get("min")
            or value.get("minimum")
            or value.get("from")
        )

        maximum = (
            value.get("max")
            or value.get("maximum")
            or value.get("to")
        )

        if minimum and maximum:
            return f"{minimum}–{maximum} employees"

        if minimum:
            return f"{minimum}+ employees"

    return _clean_string(
        value,
        default="Team size not disclosed",
    )


# ==============================================================================
# SALARY FORMATTER
# ==============================================================================

def _format_salary(job: dict) -> str:
    """
    Formats the salary while preserving the available currency.
    """

    lo = job.get("salary_min")
    hi = job.get("salary_max")

    currency = (
        job.get("salary_currency")
        or job.get("currency")
        or ""
    )

    currency = str(currency).strip().upper()

    # Map common currency codes to display symbols.
    currency_symbols = {
        "PHP": "₱",
        "USD": "$",
        "CAD": "C$",
        "AUD": "A$",
        "SGD": "S$",
        "GBP": "£",
        "EUR": "€",
    }

    symbol = currency_symbols.get(
        currency,
        currency + " " if currency else "",
    )

    try:

        if lo is not None and hi is not None:
            return (
                f"{symbol}{int(lo):,} – "
                f"{symbol}{int(hi):,}"
            )

        if lo is not None:
            return f"From {symbol}{int(lo):,}"

        if hi is not None:
            return f"Up to {symbol}{int(hi):,}"

    except (TypeError, ValueError):

        # If the API gave us a non-numeric salary, preserve it safely.
        return _clean_string(
            job.get("salary"),
            default="Not disclosed",
        )

    return "Not disclosed"


# ==============================================================================
# SHAPE TOP JOBS
# ==============================================================================

def _shape_top_jobs(top_jobs: list) -> list[dict]:
    """
    Converts ScoredJob objects into frontend-friendly dictionaries while
    preserving API metadata.
    """

    shaped = []

    for scored_job in top_jobs:

        job = getattr(scored_job, "job", None)

        if job is None:
            logger.warning(
                "Skipping scored job without a job object."
            )
            continue

        # Extract all location components.
        city = _clean_string(
            _get_attr(
                job,
                "city",
                "job_city",
                "location_city",
            )
        )

        state = _clean_string(
            _get_attr(
                job,
                "state",
                "job_state",
                "location_state",
                "province",
                "region",
            )
        )

        country = _clean_string(
            _get_attr(
                job,
                "country",
                "job_country",
                "location_country",
            )
        )

        shaped.append(
            {
                # --------------------------------------------------------------
                # Basic job information
                # --------------------------------------------------------------
                "title": _clean_string(
                    _get_attr(
                        job,
                        "title",
                        "job_title",
                    ),
                    default="Untitled job",
                ),

                "company": _clean_string(
                    _get_attr(
                        job,
                        "company",
                        "employer_name",
                        "company_name",
                    ),
                    default="Company not disclosed",
                ),

                # --------------------------------------------------------------
                # Full location information
                # --------------------------------------------------------------
                "location": _format_location(job),

                "city": city,

                "state": state,

                "country": country,

                # --------------------------------------------------------------
                # API employment information
                # --------------------------------------------------------------
                "jobType": _get_job_type(job),

                "experienceLevel": _get_experience_level(job),

                "teamSize": _get_team_size(job),

                # --------------------------------------------------------------
                # Job link
                # --------------------------------------------------------------
                "url": _clean_string(
                    _get_attr(
                        job,
                        "url",
                        "job_apply_link",
                        "apply_link",
                    ),
                    default="",
                ),

                # --------------------------------------------------------------
                # Match information
                # --------------------------------------------------------------
                "total_score": getattr(
                    scored_job,
                    "total_score",
                    0,
                ),

                "matched_skills": list(
                    getattr(
                        scored_job,
                        "matched_skills",
                        [],
                    )
                    or []
                ),

                "matched_keywords": list(
                    getattr(
                        scored_job,
                        "matched_keywords",
                        [],
                    )
                    or []
                ),

                # Raw 0-1 embedding cosine similarity (see
                # ScoredJob.semantic_similarity) — kept alongside the
                # weighted score_breakdown below so the frontend can show
                # "X% semantically similar" without having to reverse the
                # 0-20 point scale back into a percentage.
                "semantic_similarity": round(
                    getattr(scored_job, "semantic_similarity", 0.0) or 0.0,
                    3,
                ),

                # Per-component point breakdown behind total_score, for the
                # same "how was this calculated" transparency treatment the
                # ATS score modal already gives dimension scores
                # (AssessmentSidebar.tsx). Weights: keyword 30 / skills 30 /
                # semantic 20 / api_match 10 / title 10, out of 100.
                "score_breakdown": {
                    "keyword_score": getattr(scored_job, "keyword_score", 0) or 0,
                    "skills_score": getattr(scored_job, "skills_score", 0) or 0,
                    "semantic_score": getattr(scored_job, "semantic_score", 0) or 0,
                    "api_match_score": getattr(scored_job, "api_match_score", 0) or 0,
                    "title_score": getattr(scored_job, "title_score", 0) or 0,
                },

                # --------------------------------------------------------------
                # Description
                # --------------------------------------------------------------
                "description": _clean_string(
                    _get_attr(
                        job,
                        "description",
                        "job_description",
                    ),
                    default="",
                )[:500],

                # --------------------------------------------------------------
                # Salary
                # --------------------------------------------------------------
                "salary_min": _get_attr(
                    job,
                    "salary_min",
                    "job_min_salary",
                    "min_salary",
                ),

                "salary_max": _get_attr(
                    job,
                    "salary_max",
                    "job_max_salary",
                    "max_salary",
                ),

                "salary_currency": _clean_string(
                    _get_attr(
                        job,
                        "salary_currency",
                        "job_salary_currency",
                        "currency",
                    )
                ),

                # --------------------------------------------------------------
                # Original API job ID
                # --------------------------------------------------------------
                "job_id": _clean_string(
                    _get_attr(
                        job,
                        "job_id",
                        "id",
                    )
                ),
            }
        )

    return shaped


# ==============================================================================
# SHAPE COMPANY RESULTS
# ==============================================================================

def _shape_companies(
    top_companies: list,
    top_jobs_shaped: list[dict],
    raw_jobs: list | None = None,
) -> list[dict]:
    """
    Builds company cards from actual matched jobs.

    No hardcoded job type, experience level, location, or team size is used.
    """

    raw_jobs = raw_jobs or []

    shaped = []

    # --------------------------------------------------------------------------
    # Helper for normalized company comparison.
    # --------------------------------------------------------------------------

    def normalize_company(value: Any) -> str:

        return _clean_string(
            value
        ).strip().lower()

    # --------------------------------------------------------------------------
    # Process ranked companies.
    # --------------------------------------------------------------------------

    for company_match in top_companies:

        company_name = _clean_string(
            _get_attr(
                company_match,
                "company",
                "company_name",
                default="Company not disclosed",
            ),
            default="Company not disclosed",
        )

        company_key = normalize_company(company_name)

        # ----------------------------------------------------------------------
        # Find all matching shaped jobs for this company.
        # ----------------------------------------------------------------------

        company_jobs = [
            job
            for job in top_jobs_shaped
            if normalize_company(
                job.get("company")
            ) == company_key
        ]

        # ----------------------------------------------------------------------
        # If the company isn't represented in top_jobs, search raw API jobs.
        # ----------------------------------------------------------------------

        raw_company_jobs = []

        if not company_jobs:

            for raw_job in raw_jobs:

                raw_company = _clean_string(
                    _get_attr(
                        raw_job,
                        "company",
                        "employer_name",
                        "company_name",
                    )
                )

                if normalize_company(raw_company) == company_key:
                    raw_company_jobs.append(raw_job)

        # ----------------------------------------------------------------------
        # Use the first available job as the company's metadata source.
        # ----------------------------------------------------------------------

        source_job = None

        if company_jobs:
            source_job = company_jobs[0]

        elif raw_company_jobs:
            raw = raw_company_jobs[0]

            source_job = {
                "location": _format_location(raw),
                "city": _clean_string(
                    _get_attr(
                        raw,
                        "city",
                        "job_city",
                        "location_city",
                    )
                ),
                "state": _clean_string(
                    _get_attr(
                        raw,
                        "state",
                        "job_state",
                        "location_state",
                        "province",
                        "region",
                    )
                ),
                "country": _clean_string(
                    _get_attr(
                        raw,
                        "country",
                        "job_country",
                        "location_country",
                    )
                ),
                "jobType": _get_job_type(raw),
                "experienceLevel": _get_experience_level(raw),
                "teamSize": _get_team_size(raw),
                "salary_min": _get_attr(
                    raw,
                    "salary_min",
                    "job_min_salary",
                    "min_salary",
                ),
                "salary_max": _get_attr(
                    raw,
                    "salary_max",
                    "job_max_salary",
                    "max_salary",
                ),
                "salary_currency": _clean_string(
                    _get_attr(
                        raw,
                        "salary_currency",
                        "job_salary_currency",
                        "currency",
                    )
                ),
                "url": _clean_string(
                    _get_attr(
                        raw,
                        "url",
                        "job_apply_link",
                        "apply_link",
                    )
                ),
                "description": _clean_string(
                    _get_attr(
                        raw,
                        "description",
                        "job_description",
                    )
                ),
            }

        # ----------------------------------------------------------------------
        # Build metadata from the matched job.
        # ----------------------------------------------------------------------

        if source_job is None:

            location = "Location not disclosed"
            job_type = "Job type not disclosed"
            experience_level = "Experience level not disclosed"
            team_size = "Team size not disclosed"
            salary = "Not disclosed"
            top_job_url = ""

        else:

            location = _clean_string(
                source_job.get(
                    "location",
                    "Location not disclosed",
                ),
                default="Location not disclosed",
            )

            job_type = _clean_string(
                source_job.get(
                    "jobType",
                    "Job type not disclosed",
                ),
                default="Job type not disclosed",
            )

            experience_level = _clean_string(
                source_job.get(
                    "experienceLevel",
                    "Experience level not disclosed",
                ),
                default="Experience level not disclosed",
            )

            team_size = _clean_string(
                source_job.get(
                    "teamSize",
                    "Team size not disclosed",
                ),
                default="Team size not disclosed",
            )

            salary = _format_salary(
                source_job
            )

            top_job_url = _clean_string(
                source_job.get(
                    "url",
                    ""
                )
            )

        # ----------------------------------------------------------------------
        # Requirements.
        #
        # For now, preserve your existing frontend contract. We use actual
        # matching job titles instead of inventing requirements.
        #
        # You can later replace this with extracted requirements from the job
        # descriptions or job_requirements.py.
        # ----------------------------------------------------------------------

        requirements = [
            job["title"]
            for job in company_jobs[:4]
            if job.get("title")
        ]

        if not requirements:
            requirements = [
                "See job posting for details"
            ]

        # ----------------------------------------------------------------------
        # Match percentage.
        # ----------------------------------------------------------------------

        top_score = _get_attr(
            company_match,
            "top_score",
            "score",
            "match_score",
            default=0,
        )

        try:
            match_pct = round(float(top_score))
        except (TypeError, ValueError):
            match_pct = 0

        # Keep the score between 0 and 100.
        match_pct = max(
            0,
            min(
                match_pct,
                100,
            ),
        )

        # ----------------------------------------------------------------------
        # Company statistics.
        # ----------------------------------------------------------------------

        job_count = _get_attr(
            company_match,
            "job_count",
            "count",
            default=len(company_jobs),
        )

        avg_score = _get_attr(
            company_match,
            "avg_score",
            "average_score",
            default=match_pct,
        )

        # ----------------------------------------------------------------------
        # Reason text.
        # ----------------------------------------------------------------------

        reason = (
            f"{job_count} matching role"
            f"{'s' if job_count != 1 else ''} found "
            f"· Avg score {avg_score}/100"
        )

        # Highlight companies explicitly selected by the user.
        if bool(
            _get_attr(
                company_match,
                "targeted",
                default=False,
            )
        ):
            reason = (
                f"🎯 One of your target companies · {reason}"
            )

        # ----------------------------------------------------------------------
        # Append final company object.
        # ----------------------------------------------------------------------

        shaped.append(
            {
                "company": company_name,
                "match": match_pct,
                "reason": reason,
                "location": location,
                "jobType": job_type,
                "experienceLevel": experience_level,
                "salary": salary,
                "teamSize": team_size,
                "requirements": requirements,
                "top_job_url": top_job_url,
            }
        )

    return shaped


# ==============================================================================
# PERSIST RESUME
# ==============================================================================

def _persist_resume(
    parsed,
    filename: str,
    user_id: str | None,
    file_size_kb: float,
    target_job: str,
    target_companies: list[str],
) -> str | None:

    row = {
        "user_id": user_id,
        "filename": filename,
        "file_type": parsed.file_type,
        "file_size_kb": file_size_kb,
        "raw_text": parsed.raw_text,
        "contact_block": parsed.contact_block,
        "summary_block": parsed.summary_block,
        "experience_block": parsed.experience_block,
        "education_block": parsed.education_block,
        "skills_block": parsed.skills_block,
        "projects_block": parsed.projects_block,
        "certifications_block": parsed.certifications_block,
        "other_block": parsed.other_block,
        "word_count": parsed.word_count,
        "char_count": parsed.char_count,
        "section_count": parsed.section_count,
        "target_job": target_job,
        "target_companies": target_companies,
    }

    try:

        response = (
            supabase_admin
            .table("resumes")
            .insert(row)
            .execute()
        )

        if not response.data:

            logger.error(
                "Insert into resumes returned no rows "
                "(user_id=%s)",
                user_id,
            )

            return None

        inserted_row = response.data[0]

        if not isinstance(inserted_row, dict):

            logger.error(
                "Insert into resumes returned an invalid row "
                "(user_id=%s): %r",
                user_id,
                inserted_row,
            )

            return None

        raw_resume_id = inserted_row.get("id")

        if raw_resume_id is None:

            logger.error(
                "Insert into resumes returned a row without an id "
                "(user_id=%s)",
                user_id,
            )

            return None

        resume_id = str(raw_resume_id)

        logger.info(
            "analyze_controller | resume persisted | "
            "id=%s user_id=%s",
            resume_id,
            user_id,
        )

        return resume_id

    except Exception:

        logger.exception(
            "Failed to persist resume row "
            "(user_id=%s) — continuing without it",
            user_id,
        )

        return None


# ==============================================================================
# PERSIST ANALYSIS RESULT
# ==============================================================================

def _persist_analysis_result(
    resume_id: str | None,
    user_id: str | None,
    enrichment: dict,
    extracted_skills: list[str],
    companies_shaped: list[dict],
    result_payload: dict | None = None,
) -> str | None:

    if resume_id is None:

        logger.warning(
            "Skipping analysis_results insert "
            "(user_id=%s) — no resume_id",
            user_id,
        )

        return None

    section_values = {
        s["name"]: s["value"]
        for s in enrichment.get("sections", [])
    }

    row = {
        "resume_id": resume_id,
        "user_id": user_id,
        "ats_score": enrichment["ats_score"],
        "keyword_score": section_values.get("Keywords"),
        "formatting_score": section_values.get("Format"),
        "experience_score": None,
        "skills_score": section_values.get("Skills"),
        "grammar_score": None,
        "extracted_skills": extracted_skills,
        "skill_gaps": enrichment["skill_gaps"],
        "strengths": enrichment["strengths"],
        "improvements": enrichment["improvements"],
        "grammar_issues": enrichment["grammar_issues"],
        "company_matches": companies_shaped,
        "detected_role": None,
        # Full /api/analyze payload so Resume History -> "View Results"
        # re-opens certifications, top_jobs, keyword_gaps, etc.
        # (column added by 003_analysis_result_payload.sql).
        "result_json": result_payload,
    }

    try:

        response = (
            supabase_admin
            .table("analysis_results")
            .insert(row)
            .execute()
        )

        if not response.data:

            logger.error(
                "Insert into analysis_results returned no rows "
                "(resume_id=%s)",
                resume_id,
            )

            return None

        inserted_row = response.data[0]

        if not isinstance(inserted_row, dict):

            logger.error(
                "Insert into analysis_results returned invalid row "
                "(resume_id=%s): %r",
                resume_id,
                inserted_row,
            )

            return None

        raw_analysis_id = inserted_row.get("id")

        if raw_analysis_id is None:

            logger.error(
                "Insert into analysis_results returned a row "
                "without an id (resume_id=%s)",
                resume_id,
            )

            return None

        analysis_id = str(raw_analysis_id)

        logger.info(
            "analyze_controller | analysis_result persisted | "
            "id=%s resume_id=%s",
            analysis_id,
            resume_id,
        )

        return analysis_id

    except Exception:

        logger.exception(
            "Failed to persist analysis_results row "
            "(resume_id=%s) — continuing without it",
            resume_id,
        )

        return None


# ==============================================================================
# JOB-POSTING TEXT SELECTION (for skill-gap comparison)
# ==============================================================================

def _tokenize_for_exclusion(text: str) -> set[str]:
    """
    Splits job title / company name text into lowercase tokens suitable
    for excluding from skill-gap extraction (see
    extract_skill_terms_from_posting()'s exclude_terms param).

    This is deliberately a plain, dumb tokenizer (no stemming, no stop
    words) — its only job is to make sure literal words from the job's
    own title/company (e.g. "Network", "Engineer", "Solutions") can't be
    reported back as one of that same job's required skills.
    """
    return {t for t in re.findall(r"[a-zA-Z][a-zA-Z0-9]*", text.lower()) if len(t) > 1}


def _select_job_posting_text(
    result,
) -> tuple[str | None, str | None, set[str]]:
    """
    Decides what text (if any) resume_enricher.enrich_resume_local() should
    treat as "the job posting" for the PRIMARY skill-gap comparison path.

    Priority order (per product decision):
      1. result.top_jobs[0] — the single best-matching REAL job listing
         JSearch returned, using its FULL, untruncated description (via
         the underlying ScoredJob.job.description — NOT the 500-char
         truncated copy in top_jobs_shaped, which exists only for
         display and would cut off skill mentions past that length).
      2. Otherwise (JSearch returned nothing — e.g. rate-limited, or no
         jobs matched at all): (None, None) — enrich_resume_local() then
         falls back internally to the pre-existing hardcoded taxonomy
         approach (job_requirements.py / SKILL_TAXONOMY — the "backup
         result").

    Note: the user's pasted job_description field is NOT used here — it
    still steers job matching/scoring itself (see JobMatcher.match() /
    JobScorer's target_description blending), but is deliberately not a
    skill-gap comparison source on its own. Only a real JSearch listing
    or the hardcoded taxonomy fallback are.

    Returns (job_posting_text, job_posting_source, exclude_terms):
      - source is a short, human-readable label echoed back to the
        frontend via the response's skill_gap_source field, so it's
        transparent which mode produced the skill_gaps the user is
        looking at.
      - exclude_terms is the tokenized job title + company name, so
        resume_enricher can strip the job's own metadata (e.g.
        "Solutions" from "SIGINT Solutions, LLC") out of the skill-gap
        candidate pool before it's ever scored. See
        extract_skill_terms_from_posting()'s exclude_terms param.
    """
    if result.top_jobs:
        top_scored_job = result.top_jobs[0]
        job = getattr(top_scored_job, "job", None)
        description = _get_attr(job, "description", "job_description", default="")
        if description and description.strip():
            title = _clean_string(_get_attr(job, "title", "job_title"), default="a matched role")
            company = _clean_string(_get_attr(job, "company", "employer_name"), default="a matched company")
            exclude_terms = _tokenize_for_exclusion(f"{title} {company}")
            return (
                description.strip(),
                f"your top-matching job posting ({title} at {company})",
                exclude_terms,
            )

    return None, None, set()


def _select_keyword_postings(result, n: int = 5) -> list[dict]:
    """
    Keyword and skill optimization uses the top `n` COMPANIES. For each of
    the top n ranked companies, take that company's best-scoring job and its
    FULL description.
    """
    postings: list[dict] = []
    for company_match in (result.top_companies or [])[:n]:
        scored = _get_attr(company_match, "top_job", default=None)
        job = getattr(scored, "job", None)
        description = _get_attr(job, "description", "job_description", default="")
        if not description or not description.strip():
            continue
        title = _clean_string(_get_attr(job, "title", "job_title"), default="a matched role")
        company = _clean_string(
            _get_attr(company_match, "company", "company_name"), default="a matched company"
        )
        postings.append({
            "text": description.strip(),
            "label": f"{title} at {company}",
            "company": company,
            "exclude_terms": _tokenize_for_exclusion(f"{title} {company}"),
        })
    return postings


# ==============================================================================
# SHAPE CERTIFICATIONS
# ==============================================================================
#
# CertificationRecommendations.tsx expects a flat list of
#   {name, provider, reason, relevance}   (relevance: "required" | "optional")
#
# Single source: job_requirements.py (there is no Supabase certifications
# table). Target-job gap certifications come first; certifications linked to
# the user's missing skills fill the rest (and are the only source when no
# target job was selected).
# ==============================================================================

_CERT_ACRONYMS = {
    "aws", "ccna", "ccnp", "cism", "cissp", "comptia", "cysa+", "iso", "istqb",
    "cncf", "soc", "ux", "ai", "ml", "bi", "a+", "network+", "security+",
}

_CERT_PROVIDERS = [
    ("aws ", "Amazon Web Services"),
    ("azure ", "Microsoft"),
    ("microsoft ", "Microsoft"),
    ("google ", "Google"),
    ("meta ", "Meta"),
    ("comptia ", "CompTIA"),
    ("cncf ", "CNCF"),
    ("red hat ", "Red Hat"),
    ("oracle ", "Oracle"),
    ("tableau ", "Tableau"),
    ("istqb ", "ISTQB"),
    ("nielsen norman ", "Nielsen Norman Group"),
    ("iso ", "ISO"),
    ("ccna", "Cisco"),
    ("ccnp", "Cisco"),
    ("cissp", "(ISC)2"),
    ("cism", "ISACA"),
    ("certified ethical hacker", "EC-Council"),
    ("certified soc analyst", "EC-Council"),
    ("associate android developer", "Google"),
]


def _display_cert_name(name: str) -> str:
    words = []
    for w in name.strip().split():
        lw = w.lower()
        if lw in _CERT_ACRONYMS:
            words.append(lw.upper().replace("CYSA+", "CySA+"))
        else:
            words.append(w.capitalize())
    return " ".join(words)


def _cert_provider(name: str) -> str:
    n = name.strip().lower()
    for prefix, provider in _CERT_PROVIDERS:
        if n.startswith(prefix):
            return provider
    return ""


_MAX_CERTIFICATIONS = 12

_SKILL_CERT_INDEX: dict[str, dict[str, int]] | None = None


def _skill_cert_index() -> dict[str, dict[str, int]]:
    """
    {skill (lowercase): {cert name (lowercase): weight}} built once from
    job_requirements.py. A cert is linked to every skill listed by the roles
    that list that cert (required skill = weight 2, optional skill = 1).
    """
    global _SKILL_CERT_INDEX
    if _SKILL_CERT_INDEX is not None:
        return _SKILL_CERT_INDEX

    index: dict[str, dict[str, int]] = {}
    for job_name, job in JOB_REQUIREMENTS.items():
        if not is_it_title(job_name):
            continue
        certs = (job.get("required_certifications") or []) + (job.get("optional_certifications") or [])
        if not certs:
            continue
        for weight, key in ((2, "required_skills"), (1, "optional_skills")):
            for skill in job.get(key) or []:
                bucket = index.setdefault(skill.strip().lower(), {})
                for cert in certs:
                    c = cert.strip().lower()
                    bucket[c] = max(bucket.get(c, 0), weight)

    _SKILL_CERT_INDEX = index
    return index


def _shape_certifications(
    skill_gaps: list[dict],
    target_job_gap: dict | None = None,
) -> list[dict]:
    """
    Builds the flat list CertificationRecommendations.tsx expects.
    Source is job_requirements.py only (no Supabase certifications table):

      1. Target job selected -> its missing required / optional certifications
         ("required" / "optional").
      2. Always, to fill the card (and the only source when no target job was
         chosen) -> certifications linked to the user's MISSING skills through
         the roles in job_requirements.py ("optional").
    """
    shaped: list[dict] = []
    seen: set[str] = set()

    def _add(raw_name: str, reason: str, relevance: str) -> None:
        if len(shaped) >= _MAX_CERTIFICATIONS or not isinstance(raw_name, str):
            return
        key = raw_name.strip().lower()
        if not key or key in seen:
            return
        seen.add(key)
        shaped.append({
            "name": _display_cert_name(raw_name),
            "provider": _cert_provider(raw_name),
            "reason": reason,
            "relevance": relevance,
        })

    # -- 1. target-job certifications ---------------------------------------
    if target_job_gap:
        job = target_job_gap.get("target_job") or "your target role"
        for c in target_job_gap.get("missing_certifications", []) or []:
            _add(c, f"Expected for {job} roles and not found on your resume.", "required")
        for c in target_job_gap.get("missing_optional_certifications", []) or []:
            _add(c, f"Can strengthen your profile for {job} roles.", "optional")

    # -- 2. certifications for missing skills -------------------------------
    missing = [
        g["skill"].strip()
        for g in (skill_gaps or [])
        if g.get("missing") and isinstance(g.get("skill"), str) and g["skill"].strip()
    ]

    index = _skill_cert_index()
    scores: dict[str, int] = {}
    why: dict[str, list[str]] = {}
    for skill in missing:
        for cert, weight in index.get(skill.lower(), {}).items():
            scores[cert] = scores.get(cert, 0) + weight
            why.setdefault(cert, [])
            if skill not in why[cert]:
                why[cert].append(skill)

    for cert in sorted(scores, key=lambda c: (-scores[c], c)):
        skills_txt = ", ".join(why[cert][:3])
        _add(cert, f"Relevant to your skill gap: {skills_txt}.", "optional")

    logger.info(
        "Certifications shaped: %d (target-job gap: %s, missing skills: %s)",
        len(shaped),
        "yes" if target_job_gap else "no",
        missing,
    )
    return shaped


# ==============================================================================
# HANDLE ANALYZE
# ==============================================================================

def _parse_target_companies(raw: str | None) -> list[str]:
    """
    Target companies arrive as ONE multipart form string. The dashboard sends
    them comma-separated ("Jollibee, Nintendo"); older callers send a JSON list
    ('["Jollibee", "Nintendo"]'). Accept both. Blank = "Any" company -> [].
    Company names can't contain commas (the form's name check blocks them).
    """
    text = (raw or "").strip()
    if not text:
        return []

    items: list = []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            items = parsed
        elif isinstance(parsed, str):
            items = parsed.split(",")
    except (json.JSONDecodeError, TypeError):
        items = text.split(",")

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        name = str(item).strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            cleaned.append(name)
    return cleaned[:10]


async def handle_analyze(
    file: UploadFile,
    target_job: str,
    target_companies: str,
    job_description: str = "",
    user_id: str | None = None,
    internship_only: bool = False,
) -> dict:

    # ==========================================================================
    # STEP 1: VALIDATE FILE
    # ==========================================================================

    if file.content_type not in ALLOWED_RESUME_MIME_TYPES:

        raise HTTPException(
            status_code=400,
            detail="Only PDF and DOCX files are supported.",
        )

    # ==========================================================================
    # STEP 1.5: IT-ONLY TARGET JOB
    #
    # Aura is scoped to the IT field. The Upload form's dropdown only offers
    # IT titles; this is the server-side guard for direct API calls. A blank
    # title is still allowed (the search then runs from the resume keywords).
    # ==========================================================================

    # `target_job` may now hold several titles, comma-separated
    # ("Backend Developer, Data Engineer"), because the Upload form allows a
    # multi-select. Blank still means "Any" (search from the resume keywords).
    # Assumes no supported title itself contains a comma.
    target_jobs: list[str] = []

    for raw_title in (target_job or "").split(","):
        title = raw_title.strip()
        if not title:
            continue

        if not is_it_title(title):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Aura currently supports IT roles only. "
                    "Please choose job titles from the IT list."
                ),
            )

        # Store/search the canonical spelling when it is one of the dropdown titles.
        canonical = canonical_it_title(title) or title
        if canonical not in target_jobs:
            target_jobs.append(canonical)

    if len(target_jobs) > MAX_TARGET_JOBS:
        raise HTTPException(
            status_code=422,
            detail=f"Please choose at most {MAX_TARGET_JOBS} job titles.",
        )

    # `target_job` is the PRIMARY (first) title, kept for logging and callers
    # that take one title. Matching, scoring and the skill-gap checklist use the
    # whole selection; `target_job_label` is what gets saved with the resume.
    target_job = target_jobs[0] if target_jobs else ""
    target_job_label = ", ".join(target_jobs)

    # ==========================================================================
    # STEP 2: PARSE TARGET COMPANIES
    # ==========================================================================

    target_companies_list = _parse_target_companies(target_companies)

    # ==========================================================================
    # STEP 3: READ FILE
    # ==========================================================================

    try:

        file_bytes = await file.read()

    except Exception:

        logger.exception(
            "Failed to read uploaded file"
        )

        raise HTTPException(
            status_code=400,
            detail=(
                "Could not read the uploaded file. "
                "Please try again."
            ),
        )

    # ==========================================================================
    # STEP 4: PARSE RESUME
    # ==========================================================================

    try:

        parsed = parse_resume(
            file_bytes,
            filename=file.filename or "",
        )

    except ValueError as e:

        raise HTTPException(
            status_code=422,
            detail=str(e),
        )

    except Exception:

        logger.exception(
            "Unexpected error while parsing resume file"
        )

        raise HTTPException(
            status_code=422,
            detail=(
                "Could not read this file. "
                "It may be corrupted or unsupported."
            ),
        )

    # ==========================================================================
    # STEP 5: JOB MATCHING
    # ==========================================================================

    try:

        matcher = JobMatcher(
            api_key=os.getenv(
                "JSEARCH_API_KEY",
                "",
            )
        )

        result = matcher.match(
            parsed,
            target_job=target_job,
            target_job_description=job_description,
            target_companies=target_companies_list,
            internship_only=internship_only,
            target_jobs=target_jobs,
        )

    except ValueError as e:

        logger.error(
            "Job matching unavailable: %s",
            e,
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Job matching is temporarily unavailable. "
                "Please try again later."
            ),
        )

    except Exception:

        logger.exception(
            "Unexpected error during job matching"
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Something went wrong while analyzing "
                "your resume. Please try again."
            ),
        )

    # ==========================================================================
    # STEP 6: SHAPE JOB + COMPANY RESULTS
    # ==========================================================================

    try:

        top_jobs_shaped = _shape_top_jobs(
            result.top_jobs
        )

        companies_shaped = _shape_companies(
            result.top_companies,
            top_jobs_shaped,
            result.raw_jobs,
        )

        logger.info(
            "Analysis results | jobs=%d | top_jobs=%d | companies=%d",
            result.total_jobs,
            len(top_jobs_shaped),
            len(companies_shaped),
        )

    except Exception:

        logger.exception(
            "Unexpected error while shaping match results"
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Something went wrong while formatting "
                "your results. Please try again."
            ),
        )

    # ==========================================================================
    # STEP 7: TARGET JOB GAP
    # ==========================================================================

    target_job_gap = calculate_target_job_gap(
        target_job_label,
        parsed,
    )

    if target_job_label and target_job_gap is None:
        # A valid IT title with no entry in job_requirements.py: the gap
        # checklist is skipped and skill gaps come from the job posting /
        # taxonomy fallback instead.
        logger.info(
            "No job_requirements entry for IT target job(s) %r — skipping target-job gap.",
            target_job_label,
        )

    # ==========================================================================
    # STEP 7.5: SELECT JOB-POSTING TEXT FOR SKILL-GAP COMPARISON
    #
    # Priority: best-matching real JSearch job listing (full, untruncated
    # description) -> None (enrich_resume_local then falls back to the
    # hardcoded job_requirements.py / SKILL_TAXONOMY taxonomy).
    # ==========================================================================

    job_posting_text, job_posting_source, job_posting_exclude_terms = _select_job_posting_text(result)

    if job_posting_text:
        logger.info("Skill-gap comparison source: %s", job_posting_source)
    else:
        logger.info(
            "Skill-gap comparison source: none available — falling back "
            "to hardcoded taxonomy"
        )

    keyword_postings = _select_keyword_postings(result, n=5)
    logger.info(
        "Keyword source: %d posting(s) from top companies: %s",
        len(keyword_postings),
        [p["label"] for p in keyword_postings],
    )

    # ==========================================================================
    # STEP 8: RESUME ENRICHMENT
    # ==========================================================================

    logger.info(
        "Running local resume enrichment..."
    )

    try:

        enrichment = enrich_resume_local(
            resume=parsed,
            keywords=result.keywords,
            top_jobs=top_jobs_shaped,
            target_job_gap=target_job_gap,
            job_posting_text=job_posting_text,
            job_posting_source=job_posting_source,
            job_posting_exclude_terms=job_posting_exclude_terms,
            keyword_postings=keyword_postings,
        )

    except Exception:

        logger.exception(
            "Unexpected error during resume enrichment"
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Something went wrong while scoring "
                "your resume. Please try again."
            ),
        )

    logger.info(
        "Enrichment complete — ATS score: %d",
        enrichment["ats_score"],
    )

    # ==========================================================================
    # STEP 8.5: CERTIFICATION RECOMMENDATIONS
    # ==========================================================================

    certifications_shaped = _shape_certifications(
        enrichment["skill_gaps"],
        target_job_gap,
    )

    # ==========================================================================
    # STEP 9: PERSIST RESUME
    # ==========================================================================

    file_size_kb = round(
        len(file_bytes) / 1024,
        2,
    )

    resume_id = _persist_resume(
        parsed,
        filename=file.filename or "upload",
        user_id=user_id,
        file_size_kb=file_size_kb,
        target_job=target_job_label,
        target_companies=target_companies_list,
    )

    # ==========================================================================
    # STEP 10: PERSIST ANALYSIS
    # ==========================================================================

    response_payload = {
        "keywords": result.keywords,
        "total_jobs": result.total_jobs,
        "top_jobs": top_jobs_shaped,
        "companies": companies_shaped,
        "ats_score": enrichment["ats_score"],
        "sections": enrichment["sections"],
        "strengths": enrichment["strengths"],
        "improvements": enrichment["improvements"],
        "skill_gaps": enrichment["skill_gaps"],
        "skill_gap_source": enrichment["skill_gap_source"],
        "keyword_gaps": enrichment["keyword_gaps"],
        "keyword_gap_source": enrichment["keyword_gap_source"],
        "grammar_issues": enrichment["grammar_issues"],
        "certifications": certifications_shaped,
    }

    analysis_id = _persist_analysis_result(
        resume_id=resume_id,
        user_id=user_id,
        enrichment=enrichment,
        extracted_skills=result.keywords,
        companies_shaped=companies_shaped,
        result_payload=response_payload,
    )

    # ==========================================================================
    # STEP 11: FINAL RESPONSE
    # ==========================================================================

    return {
        "user_id": user_id,

        "resume_id": resume_id,

        "analysis_id": analysis_id,

        "keywords": result.keywords,

        "total_jobs": result.total_jobs,

        "top_jobs": top_jobs_shaped,

        "companies": companies_shaped,

        "ats_score": enrichment["ats_score"],

        "sections": enrichment["sections"],

        "strengths": enrichment["strengths"],

        "improvements": enrichment["improvements"],

        "skill_gaps": enrichment["skill_gaps"],

        "skill_gap_source": enrichment["skill_gap_source"],

        "keyword_gaps": enrichment["keyword_gaps"],

        "keyword_gap_source": enrichment["keyword_gap_source"],

        "grammar_issues": enrichment["grammar_issues"],

        "certifications": certifications_shaped,
    }