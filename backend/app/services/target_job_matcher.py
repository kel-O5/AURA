"""
FILE: app/services/target_job_matcher.py

PURPOSE:
    Handles target-job skill and certification gap analysis.

This service uses JOB_REQUIREMENTS from:
    app/data/job_requirements.py

JOB_REQUIREMENTS is the single source of truth for:
    - Required skills
    - Optional skills
    - Required certifications
    - Optional certifications

This file also supports JOB_TITLE_ALIASES so that different
versions of a job title can still resolve to the correct
supported target job.
"""

from typing import Optional

from app.data.job_requirements import (
    JOB_REQUIREMENTS,
    JOB_TITLE_ALIASES,
)

from app.models.schemas import ParsedResume
from app.services.skill_matcher import skills_present
from app.data.it_domain import is_it_title


# ============================================================
# BUILD NORMALIZED JOB LOOKUP
# ============================================================
# JOB_REQUIREMENTS uses display-friendly titles such as:
#
#     "Backend Developer"
#     "QA Engineer"
#     "UI/UX Designer"
#
# We create a lowercase lookup so the backend can safely accept:
#
#     "Backend Developer"
#     "backend developer"
#     " BACKEND DEVELOPER "
#
# without changing the original JOB_REQUIREMENTS dictionary.
# ============================================================

_NORMALIZED_JOB_LOOKUP: dict[str, str] = {
    job_name.strip().lower(): job_name
    for job_name in JOB_REQUIREMENTS
}


# ============================================================
# BUILD JOB ALIAS LOOKUP
# ============================================================
# Example:
#
#     "front-end developer"
#     "frontend engineer"
#     "web developer"
#
# can all resolve to:
#
#     "Frontend Developer"
#
# The aliases in job_requirements.py are lowercase, so they are
# normalized here as well.
# ============================================================

_ALIAS_LOOKUP: dict[str, str] = {}

for canonical_job, aliases in JOB_TITLE_ALIASES.items():

    # Find the actual JOB_REQUIREMENTS key.
    canonical_key = _NORMALIZED_JOB_LOOKUP.get(
        canonical_job.strip().lower()
    )

    # Skip the alias group if the canonical job does not exist.
    if canonical_key is None:
        continue

    for alias in aliases:
        _ALIAS_LOOKUP[alias.strip().lower()] = canonical_key


# ============================================================
# RESOLVE TARGET JOB
# ============================================================

def _resolve_target_job(target_job: str) -> Optional[str]:
    """
    Converts a user/frontend target-job value into the exact
    JOB_REQUIREMENTS key.

    Examples:

        "Backend Developer"
            -> "Backend Developer"

        "backend developer"
            -> "Backend Developer"

        "front-end developer"
            -> "Frontend Developer"

        "frontend engineer"
            -> "Frontend Developer"

        "unknown job"
            -> None
    """

    if not target_job:
        return None

    normalized = target_job.strip().lower()

    # --------------------------------------------------------
    # First try the actual supported job titles.
    # --------------------------------------------------------
    canonical_job = _NORMALIZED_JOB_LOOKUP.get(normalized)

    if canonical_job:
        # IT-only: a supported job that is not an IT role is not resolved.
        return canonical_job if is_it_title(canonical_job) else None

    # --------------------------------------------------------
    # Then try the aliases.
    # --------------------------------------------------------
    aliased_job = _ALIAS_LOOKUP.get(normalized)
    return aliased_job if aliased_job and is_it_title(aliased_job) else None


# ============================================================
# MULTIPLE TARGET JOBS
# ============================================================

def split_target_jobs(target_job: str) -> list[str]:
    """
    "Backend Developer, Data Engineer" -> ["Backend Developer", "Data Engineer"].
    The upload form can send several titles joined with commas. A single
    title (or blank) comes back as a 0/1-item list.
    """
    return [t.strip() for t in (target_job or "").split(",") if t.strip()]


def _unique(items: list) -> list:
    return list(dict.fromkeys(items))


def merge_target_job_gaps(gaps: list[dict]) -> Optional[dict]:
    """
    Combines per-title gap results into ONE dict with the same shape the rest
    of the pipeline already expects (resume_enricher, certifications).

    - "target_job" becomes the titles joined with ", ".
    - matched lists are the union across titles.
    - a skill/certification still missing for ANY chosen title stays missing;
      something required for one title and only optional for another is kept
      as required.
    """
    gaps = [g for g in gaps if g]
    if not gaps:
        return None
    if len(gaps) == 1:
        return gaps[0]

    def union(key: str) -> list:
        return _unique([item for g in gaps for item in g.get(key, [])])

    missing_required = union("missing_required_skills")
    missing_certs = union("missing_certifications")

    return {
        "target_job": ", ".join(_unique([g["target_job"] for g in gaps])),
        "matched_skills": union("matched_skills"),
        "missing_required_skills": missing_required,
        "missing_optional_skills": [
            s for s in union("missing_optional_skills") if s not in missing_required
        ],
        "matched_certifications": union("matched_certifications"),
        "missing_certifications": missing_certs,
        "missing_optional_certifications": [
            c for c in union("missing_optional_certifications") if c not in missing_certs
        ],
    }


# ============================================================
# GET SUPPORTED TARGET JOBS
# ============================================================

def get_supported_target_jobs() -> list[str]:
    """
    Returns the official IT job titles from JOB_REQUIREMENTS
    (non-IT entries are excluded — Aura is IT-only).

    This should be used by the frontend dropdown instead of
    maintaining a second hardcoded list.
    """

    return sorted(job for job in JOB_REQUIREMENTS if is_it_title(job))


# ============================================================
# NORMALIZE RESUME TEXT
# ============================================================

def _build_resume_haystack(
    skills_block: Optional[str],
    raw_text: Optional[str],
) -> str:
    """
    Combines resume skill data and raw resume text into one
    lowercase searchable string.
    """

    return " ".join(
        value
        for value in [skills_block, raw_text]
        if value
    ).lower()


# ============================================================
# CERTIFICATION PRESENCE (literal match only)
# ============================================================

def _cert_present(certification: str, haystack: str) -> bool:
    """True only if the certification name literally appears on the resume."""
    return certification.strip().lower() in haystack


# ============================================================
# CALCULATE TARGET JOB GAP
# ============================================================

def calculate_target_job_gap(
    target_job: str,
    resume: ParsedResume,
) -> Optional[dict]:
    """
    Calculates the skill and certification gaps for a target job.

    Returns None when:
        - target_job is blank
        - target_job is not supported

    Example return:

    {
        "target_job": "Backend Developer",
        "matched_skills": [
            "python",
            "sql",
            "git"
        ],
        "missing_required_skills": [
            "rest api"
        ],
        "missing_optional_skills": [
            "docker",
            "kubernetes"
        ],
        "missing_certifications": [
            "aws certified developer"
        ]
    }
    """

    # --------------------------------------------------------
    # Several titles ("A, B"): analyse each one, then merge.
    # --------------------------------------------------------

    titles = split_target_jobs(target_job)
    if len(titles) > 1:
        return merge_target_job_gaps(
            [calculate_target_job_gap(t, resume) for t in titles]
        )

    # --------------------------------------------------------
    # Resolve the submitted job title.
    # --------------------------------------------------------

    canonical_job = _resolve_target_job(target_job)

    if canonical_job is None:
        return None

    # --------------------------------------------------------
    # Get the job requirements.
    # --------------------------------------------------------
    #
    # IMPORTANT:
    # Your JOB_REQUIREMENTS structure is:
    #
    # {
    #     "required_skills": [...],
    #     "optional_skills": [...],
    #     "required_certifications": [...],
    #     "optional_certifications": [...]
    # }
    #
    # Therefore we access these directly.
    # --------------------------------------------------------

    job = JOB_REQUIREMENTS[canonical_job]

    # --------------------------------------------------------
    # Build searchable resume text.
    # --------------------------------------------------------

    resume_skills_block = getattr(resume, "skills_block", None)
    resume_raw_text = getattr(resume, "raw_text", None)

    haystack = _build_resume_haystack(resume_skills_block, resume_raw_text)

    # --------------------------------------------------------
    # Get requirements.
    # --------------------------------------------------------

    required_skills = job["required_skills"]
    optional_skills = job["optional_skills"]

    required_certifications = job["required_certifications"]
    optional_certifications = job["optional_certifications"]

    # --------------------------------------------------------
    # Check every required/optional skill and certification against
    # the resume ONCE, via skill_matcher. Each term first gets the
    # same free substring check as before (haystack is unchanged); a
    # term only reaches the semantic fallback — catching e.g. "React
    # framework" on the resume for a required skill of "React.js" — if
    # substring matching missed it. See skill_matcher.py for details.
    # --------------------------------------------------------

    # Certifications are deliberately NOT sent through the semantic fallback:
    # a certificate title like "meta frontend developer professional
    # certificate" is embedding-similar to a resume line such as "Frontend
    # Developer", which wrongly marked it as already held. Certs need a
    # literal mention on the resume (see _cert_present below).
    all_terms = list(dict.fromkeys(required_skills + optional_skills))
    matches = skills_present(
        all_terms,
        haystack,
        skills_block=resume_skills_block,
        raw_text=resume_raw_text,
    )

    # --------------------------------------------------------
    # Find matched skills.
    # --------------------------------------------------------

    matched_skills = [
        skill
        for skill in required_skills + optional_skills
        if matches[skill].present
    ]

    # --------------------------------------------------------
    # Find missing required skills.
    # --------------------------------------------------------

    missing_required_skills = [
        skill
        for skill in required_skills
        if not matches[skill].present
    ]

    # --------------------------------------------------------
    # Find missing optional skills.
    # --------------------------------------------------------

    missing_optional_skills = [
        skill
        for skill in optional_skills
        if not matches[skill].present
    ]

    # --------------------------------------------------------
    # Find missing required certifications.
    # --------------------------------------------------------

    missing_certifications = [
        certification
        for certification in required_certifications
        if not _cert_present(certification, haystack)
    ]

    # --------------------------------------------------------
    # Find matched certifications.
    # --------------------------------------------------------

    matched_certifications = [
        certification
        for certification in (
            required_certifications + optional_certifications
        )
        if _cert_present(certification, haystack)
    ]

    # --------------------------------------------------------
    # Find missing optional certifications.
    # --------------------------------------------------------

    missing_optional_certifications = [
        certification
        for certification in optional_certifications
        if not _cert_present(certification, haystack)
    ]

    # --------------------------------------------------------
    # Return complete target-job analysis.
    # --------------------------------------------------------

    return {
        "target_job": canonical_job,

        "matched_skills": matched_skills,

        "missing_required_skills": missing_required_skills,

        "missing_optional_skills": missing_optional_skills,

        "matched_certifications": matched_certifications,

        "missing_certifications": missing_certifications,

        "missing_optional_certifications": (
            missing_optional_certifications
        ),
    }


# ============================================================
# CALCULATE TARGET JOB GAP FROM DATABASE ROW
# ============================================================

def calculate_target_job_gap_from_row(
    target_job: str,
    row: dict,
) -> Optional[dict]:
    """
    Same target-job analysis as calculate_target_job_gap(),
    but works directly with a Supabase resumes table row.

    This is useful for:

        POST /api/resumes/{resume_id}/analyze

    where the resume has already been parsed and stored.
    """

    # --------------------------------------------------------
    # Several titles ("A, B"): analyse each one, then merge.
    # --------------------------------------------------------

    titles = split_target_jobs(target_job)
    if len(titles) > 1:
        return merge_target_job_gaps(
            [calculate_target_job_gap_from_row(t, row) for t in titles]
        )

    # --------------------------------------------------------
    # Resolve the submitted target job.
    # --------------------------------------------------------

    canonical_job = _resolve_target_job(target_job)

    if canonical_job is None:
        return None

    # --------------------------------------------------------
    # Get the job requirements.
    # --------------------------------------------------------

    job = JOB_REQUIREMENTS[canonical_job]

    # --------------------------------------------------------
    # Safely retrieve resume fields from Supabase.
    # --------------------------------------------------------

    skills_block = row.get("skills_block")

    raw_text = row.get("raw_text")

    # --------------------------------------------------------
    # Build searchable resume text.
    # --------------------------------------------------------

    haystack = _build_resume_haystack(
        skills_block,
        raw_text,
    )

    # --------------------------------------------------------
    # Get requirements.
    # --------------------------------------------------------

    required_skills = job["required_skills"]
    optional_skills = job["optional_skills"]

    required_certifications = job["required_certifications"]
    optional_certifications = job["optional_certifications"]

    # --------------------------------------------------------
    # Check every required/optional skill and certification against
    # the resume ONCE, via skill_matcher — same substring-first,
    # semantic-fallback behavior as calculate_target_job_gap() above.
    # --------------------------------------------------------

    # Certifications are deliberately NOT sent through the semantic fallback:
    # a certificate title like "meta frontend developer professional
    # certificate" is embedding-similar to a resume line such as "Frontend
    # Developer", which wrongly marked it as already held. Certs need a
    # literal mention on the resume (see _cert_present below).
    all_terms = list(dict.fromkeys(required_skills + optional_skills))
    matches = skills_present(
        all_terms,
        haystack,
        skills_block=skills_block,
        raw_text=raw_text,
    )

    # --------------------------------------------------------
    # Match skills.
    # --------------------------------------------------------

    matched_skills = [
        skill
        for skill in required_skills + optional_skills
        if matches[skill].present
    ]

    # --------------------------------------------------------
    # Missing required skills.
    # --------------------------------------------------------

    missing_required_skills = [
        skill
        for skill in required_skills
        if not matches[skill].present
    ]

    # --------------------------------------------------------
    # Missing optional skills.
    # --------------------------------------------------------

    missing_optional_skills = [
        skill
        for skill in optional_skills
        if not matches[skill].present
    ]

    # --------------------------------------------------------
    # Matched certifications.
    # --------------------------------------------------------

    matched_certifications = [
        certification
        for certification in (
            required_certifications + optional_certifications
        )
        if _cert_present(certification, haystack)
    ]

    # --------------------------------------------------------
    # Missing required certifications.
    # --------------------------------------------------------

    missing_certifications = [
        certification
        for certification in required_certifications
        if not _cert_present(certification, haystack)
    ]

    # --------------------------------------------------------
    # Missing optional certifications.
    # --------------------------------------------------------

    missing_optional_certifications = [
        certification
        for certification in optional_certifications
        if not _cert_present(certification, haystack)
    ]

    # --------------------------------------------------------
    # Return complete analysis.
    # --------------------------------------------------------

    return {
        "target_job": canonical_job,

        "matched_skills": matched_skills,

        "missing_required_skills": missing_required_skills,

        "missing_optional_skills": missing_optional_skills,

        "matched_certifications": matched_certifications,

        "missing_certifications": missing_certifications,

        "missing_optional_certifications": (
            missing_optional_certifications
        ),
    }