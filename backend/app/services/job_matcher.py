# ==============================================================================
# FILE: app/services/job_matcher.py
# ==============================================================================
# PURPOSE OF THIS FILE (GUIDE):
#   This is the ORCHESTRATOR for the "find and score matching jobs" part of
#   the pipeline. Instead of the route/controller layer having to call
#   keyword_extractor, jsearch_client, and job_scorer separately and wire
#   their outputs together, `JobMatcher.match()` does all of that in one
#   call and returns a single, ready-to-use `MatchResult`.
#
#   Full flow this file coordinates:
#
#       ParsedResume
#            │
#            ▼
#     keyword_extractor.extract_keywords()   →  ranked keyword list
#            │
#            ▼
#     JSearchClient.fetch_jobs()             →  raw JobListing objects
#            │
#            ▼
#     JobScorer.score_all() + rank_companies()  →  ScoredJob / CompanyMatch
#            │
#            ▼
#       MatchResult  (returned to the caller — e.g. a route/controller,
#                     which then likely feeds top_jobs into
#                     resume_enricher.enrich_resume_local())
#
# WHAT LIVES HERE:
#   - `MatchResult`  : dataclass bundling everything the caller needs —
#                      the extracted keywords, total job count, the top N
#                      scored jobs, the top N company rankings, and the
#                      full raw (unscored) job list.
#   - `JobMatcher`   : the orchestrator class. Construct it once (it holds
#                      a JSearchClient and tunable limits), then call
#                      `.match(resume)` per resume.
#
# TUNABLE LIMITS (constructor args, with sensible defaults):
#   - top_keywords         : how many keywords to extract from the resume.
#   - results_per_keyword  : how many job results to request per keyword.
#   - max_keywords_queried : how many of the top keywords to actually query
#                             JSearch with (querying fewer, higher-value
#                             keywords keeps API usage down).
#   - top_jobs             : how many top-scored jobs to keep in the result.
#   - top_companies        : how many top-ranked companies to keep.
#
# EDGE CASES HANDLED:
#   If no keywords can be extracted (empty resume content) or JSearch
#   returns no jobs, `match()` short-circuits and returns an empty
#   `MatchResult` rather than letting an error propagate or a scorer run
#   on an empty list.
# ==============================================================================

# app/services/job_matcher.py
"""
Orchestrates the full resume → keywords → JSearch → scored jobs → company ranking pipeline.
"""

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import List, Optional

from app.models.schemas import ParsedResume
from app.services.keyword_extractor import extract_keywords, extract_keywords_from_text, pick_search_skills
from app.services.posting_classifier import classify_target_job
from app.services.jsearch_client import JSearchClient, JobListing
from app.services.job_scorer import JobScorer, ScoredJob, CompanyMatch
from app.data.it_domain import is_it_title, looks_like_it_job, IT_JOB_TITLES

from app.utils.logger import logger  # shared "aura" logger (the bare module logger dropped INFO lines)


@dataclass
class MatchResult:
    keywords:      List[str]
    total_jobs:    int
    top_jobs:      List[ScoredJob]
    top_companies: List[CompanyMatch]
    raw_jobs:      List[JobListing] = field(default_factory=list)
    # The exact queries sent to JSearch, and the role inferred from the
    # resume when the user didn't pick a target job (None otherwise).
    search_terms:  List[str] = field(default_factory=list)
    inferred_role: Optional[str] = None


# The dropdown's IT titles, longest first so "Cloud Security Engineer" is tried
# before "Security Engineer". Covers titles the 20 JOB_REQUIREMENTS roles don't
# (Software Engineer, Data Scientist, Web Developer, ...).
_IT_TITLE_PATTERNS = [
    (t, re.compile(r"(?<![a-z0-9])" + re.escape(t.lower()) + r"(?![a-z0-9])"))
    for t in sorted(IT_JOB_TITLES, key=len, reverse=True)
]


def _match_it_title(line: str) -> Optional[str]:
    low = line.lower()
    for title, pat in _IT_TITLE_PATTERNS:
        if pat.search(low):
            return title
    return None


def _role_from_line(line: str) -> Optional[str]:
    """JOB_REQUIREMENTS role (via aliases) first, then a dropdown IT title."""
    return classify_target_job(line) or _match_it_title(line)


def _role_query(role: str) -> str:
    """Search-friendly form of a role name. "DevOps / Platform Engineer" ->
    "DevOps Engineer", "IT Support / Systems Administrator" -> "IT Support"."""
    role = (role or "").strip()
    if " / " not in role:
        return role
    head, tail = [p.strip() for p in role.split(" / ", 1)]
    return head if len(head.split()) >= 2 else f"{head} {tail.split()[-1]}"


def infer_role(resume: ParsedResume) -> Optional[str]:
    """
    Best-guess IT role (one of the roles posting_classifier knows) from the
    resume's own job-title-looking lines: the headline under the name,
    short experience lines ("Software Engineering Intern - Acme") and short
    summary lines. Headline hits count triple. None if nothing matches.
    """
    votes: Counter = Counter()

    raw_lines = [l.strip() for l in (resume.raw_text or "").split("\n") if l.strip()]
    for line in raw_lines[:4]:
        if len(line.split()) <= 10:
            role = _role_from_line(line)
            if role:
                votes[role] += 3

    for block in (resume.experience_block, resume.summary_block):
        for line in (block or "").split("\n"):
            line = line.strip(" -•\t")
            if line and len(line.split()) <= 12:
                role = _role_from_line(line)
                if role:
                    votes[role] += 1

    return votes.most_common(1)[0][0] if votes else None


def build_search_terms(
    role: str,
    keywords: List[str],
    max_terms: int,
) -> List[str]:
    """
    JSearch queries, best first. With a role: the role alone, then the role
    combined with each of the resume's best searchable skills ("Backend
    Developer Python"), which hits real job titles far better than a bare
    skill like "Docker". Without a role: the best bare skills.
    """
    role_q = _role_query(role)
    skills = pick_search_skills(keywords, n=max(max_terms, 1))
    terms: List[str] = []
    seen: set[str] = set()

    def _add(t: str) -> None:
        k = t.lower()
        if t and k not in seen and len(terms) < max_terms:
            seen.add(k)
            terms.append(t)

    if role_q:
        _add(role_q)
        for s in skills:
            if s.lower() not in role_q.lower():
                _add(f"{role_q} {s}")
    else:
        for s in skills:
            _add(s)
        for kw in keywords:          # nothing searchable recognised: old behaviour
            _add(kw)
    return terms


# Job types that have their own dashboard filter but rarely rank high enough to
# reach it on score alone. Each gets reserved room in the results.
_RESERVED_JOB_TYPES = ("Freelance", "Internship")
_RESERVED_EXTRA_COMPANIES = 3   # extra company cards per type, beyond the normal top companies
_RESERVED_MAX_JOBS = 10         # extra top-jobs rows per type


def _company_key(match) -> str:
    """Lower-cased company name of a CompanyMatch (object or dict)."""
    if isinstance(match, dict):
        name = match.get("company") or match.get("company_name") or ""
    else:
        name = getattr(match, "company", None) or getattr(match, "company_name", None) or ""
    return str(name).strip().lower()


class JobMatcher:

    def __init__(
        self,
        api_key:              Optional[str] = None,
        top_keywords:         int = 40,
        results_per_keyword:  int = 10,
        max_keywords_queried: int = 5,
        top_jobs:             int = 20,
        top_companies:        int = 10,
        it_only:              bool = True,
    ):
        # it_only: Aura is scoped to the IT field. When True (default),
        # non-IT target titles are ignored and non-IT job listings are
        # dropped BEFORE scoring, so job openings, company matches and the
        # Keywords dimension of the assessment only ever reflect IT roles.
        self.it_only              = it_only
        self.client               = JSearchClient(api_key=api_key)
        self.top_keywords         = top_keywords
        self.results_per_keyword  = results_per_keyword
        self.max_keywords_queried = max_keywords_queried
        self._top_jobs            = top_jobs
        self._top_companies       = top_companies



    def _ensure_job_types_visible(self, scorer, scored_jobs, companies, top_jobs, target_companies):
        """Make sure Freelance and Internship postings can reach the dashboard.

        Company cards are built from the top-ranked companies, and each card's
        job type comes from that company's best-scoring job. A handful of
        freelance or internship postings among dozens of regular ones would
        normally never make the cut, leaving those filters empty.

        For each type in _RESERVED_JOB_TYPES this (1) appends up to
        _RESERVED_MAX_JOBS of its postings that missed the top-jobs list to the
        END of it (top_jobs[0] and the existing order are untouched), and
        (2) adds up to _RESERVED_EXTRA_COMPANIES company cards built from that
        type's postings, beyond the normal top companies.
        """
        companies = list(companies)
        top_jobs = list(top_jobs)
        in_top = {id(s) for s in top_jobs}
        present = {_company_key(c) for c in companies}

        for job_type in _RESERVED_JOB_TYPES:
            typed = [
                s for s in scored_jobs
                if getattr(getattr(s, "job", None), "job_type", None) == job_type
            ]
            if not typed:
                continue

            extra_jobs = [s for s in typed if id(s) not in in_top][:_RESERVED_MAX_JOBS]
            top_jobs.extend(extra_jobs)
            in_top.update(id(s) for s in extra_jobs)

            ranked = scorer.rank_companies(
                typed,
                top_n=self._top_companies,
                target_companies=target_companies,
            )
            added = [c for c in ranked if _company_key(c) not in present][:_RESERVED_EXTRA_COMPANIES]
            companies.extend(added)
            present.update(_company_key(c) for c in added)
            logger.info(
                "%s: %d posting(s) scored, %d added to top jobs, %d extra company card(s)",
                job_type, len(typed), len(extra_jobs), len(added),
            )

        return companies, top_jobs

    def match(
        self,
        resume: ParsedResume,
        target_job: str = "",
        target_job_description: str = "",
        target_companies: Optional[List[str]] = None,
        internship_only: bool = False,
        target_jobs: Optional[List[str]] = None,
    ) -> MatchResult:
        """
        PUBLIC ENTRY POINT — runs the full extract-keywords -> fetch-jobs ->
        score-jobs -> rank-companies pipeline for one resume and returns
        the combined result.

        target_job: the short target job TITLE the user typed on the
            upload form (e.g. "Data Analyst"). This is the user's most
            direct statement of the role they want — it doesn't depend
            on their resume containing the right words, and it's always
            present when the field is filled in (unlike
            target_job_description, which the current frontend never
            actually sends). Used verbatim as the top search term AND
            folded into keyword extraction / scoring below, so job
            search and company ranking are steered by what the user
            asked for, not only by what their resume happens to say.
        target_job_description: optional free-text JD the user pasted in
            on the upload form. When present, its keywords are merged
            ahead of the resume's own keywords (it's a more precise
            statement of what the user wants than anything we can infer
            from their resume alone), and JobScorer blends overlap
            against it into each job's keyword score.
        target_companies: optional list of company names the user is
            specifically interested in. Used to (a) add a few
            company-steered search queries so their listings have a
            chance to surface, and (b) pin/flag those companies in the
            ranked company list.
        """
        target_companies = target_companies or []

        # Several target titles may be selected (`target_jobs`). `target_job`
        # stays supported for single-title callers. `target_job` below always
        # means the PRIMARY (first) title.
        titles: List[str] = []
        for t in (target_jobs or []) + [target_job]:
            t = (t or "").strip()
            if t and t.lower() not in {x.lower() for x in titles}:
                titles.append(t)
        target_job = titles[0] if titles else ""
        # internship_only: when True, JSearch is queried for internship postings
        # and only listings labelled "Internship" are kept (see
        # JSearchClient.fetch_jobs). Default False = all job types, with
        # freelance postings included so the dashboard's Job Type filter can
        # show them.

        # IT-only: a target title outside the IT field is not used to steer
        # the search or scoring (the frontend dropdown already prevents this;
        # this is the server-side guard for direct API calls).
        if self.it_only:
            non_it = [t for t in titles if not is_it_title(t)]
            if non_it:
                logger.warning("Ignoring non-IT target job(s): %r", non_it)
            titles = [t for t in titles if is_it_title(t)]
        target_job = titles[0] if titles else ""

        logger.info("Extracting keywords from resume...")
        resume_keywords = extract_keywords(resume, top_n=self.top_keywords)

        # Combine the explicit target-job title with any pasted JD text
        # into one "what the user says they want" signal. The title is
        # short but always present when set; a pasted JD is longer/more
        # specific but optional (and, as of this revision, not even
        # wired up on the frontend) — both should count when present.
        target_text = " ".join([*titles, target_job_description]).strip()

        jd_keywords: List[str] = []
        if target_text:
            logger.info("Extracting keywords from target job / description...")
            jd_keywords = extract_keywords_from_text(target_text, top_n=10)

        # Merge: the target-job title itself (verbatim, not run through
        # TF-IDF — it's too short/precise for that to help), then JD
        # keywords, then resume keywords, deduplicated. Earlier entries
        # win ties for search-term priority below.
        keywords: List[str] = []
        seen: set[str] = set()
        for kw in titles + jd_keywords + resume_keywords:
            key = kw.lower()
            if key and key not in seen:
                seen.add(key)
                keywords.append(kw)

        logger.info("Keywords: %s", keywords)

        if not keywords:
            logger.warning("No keywords extracted — returning empty result.")
            return MatchResult(keywords=[], total_jobs=0, top_jobs=[], top_companies=[])

        # Search terms. With a role (the user's target job, or one inferred
        # from the resume's own titles) queries are "<role>" plus
        # "<role> <skill>" combos; otherwise the best bare skills. Total
        # query count is unchanged (max_keywords_queried) so API usage is too.
        inferred_role = None if target_job else infer_role(resume)
        role = target_job or inferred_role or ""
        if inferred_role:
            logger.info("No target job given; inferred role from resume: %r", inferred_role)

        if len(titles) > 1:
            # Several roles share the same query budget (API usage is unchanged):
            # each role's own query list is interleaved round-robin, so with
            # 3 titles the first 3 queries are one per role, then the
            # "<role> <skill>" combos follow.
            per_role = [
                build_search_terms(
                    role=t,
                    keywords=jd_keywords + resume_keywords,
                    max_terms=self.max_keywords_queried,
                )
                for t in titles
            ]
            search_terms = []
            seen_terms: set[str] = set()
            for rank in range(self.max_keywords_queried):
                for terms in per_role:
                    if rank < len(terms) and terms[rank].lower() not in seen_terms:
                        seen_terms.add(terms[rank].lower())
                        search_terms.append(terms[rank])
                    if len(search_terms) >= self.max_keywords_queried:
                        break
                if len(search_terms) >= self.max_keywords_queried:
                    break
            search_terms = search_terms or list(keywords[:self.max_keywords_queried])
        else:
            search_terms = build_search_terms(
                role=role,
                keywords=jd_keywords + resume_keywords,
                max_terms=self.max_keywords_queried,
            ) or list(keywords[:self.max_keywords_queried])

        # Add a few company-steered queries so listings from the user's
        # named target companies have a real chance of showing up, even
        # if "data analyst" alone wouldn't have surfaced them.
        top_term = _role_query(role) or (jd_keywords[0] if jd_keywords else (resume_keywords[0] if resume_keywords else None))
        if top_term:
            for company in target_companies[:3]:
                company = company.strip()
                if company:
                    search_terms.append(f"{top_term} {company}")
        logger.info("JSearch queries: %s", search_terms)

        logger.info("Fetching jobs from JSearch...")
        jobs = self.client.fetch_jobs(
            keywords=search_terms,
            results_per_keyword=self.results_per_keyword,
            max_keywords=len(search_terms),
            internship_only=internship_only,
            # Normal mode also gets one freelance-biased query so the
            # dashboard's Freelance filter has postings to show.
            include_freelance=not internship_only,
            # Search freelance work for the target role (or best JD/resume
            # term), not whichever resume skill happens to come first.
            freelance_keyword=top_term,
        )

        # IT-only: drop every listing that is not an IT role before scoring.
        if self.it_only and jobs:
            before = len(jobs)
            jobs = [j for j in jobs if looks_like_it_job(j.title, j.description)]
            logger.info("IT filter kept %d of %d jobs", len(jobs), before)

        if not jobs:
            logger.warning("No (IT) jobs returned from JSearch.")
            return MatchResult(keywords=keywords, total_jobs=0, top_jobs=[], top_companies=[], raw_jobs=[],
                               search_terms=search_terms, inferred_role=inferred_role)

        logger.info("Scoring %d jobs against resume...", len(jobs))
        scorer      = JobScorer(
            resume=resume,
            keywords=keywords,
            target_description=target_text,
            target_job=target_job,
            search_terms=search_terms,
            target_jobs=titles,
        )
        scored_jobs = scorer.score_all(jobs)
        companies   = scorer.rank_companies(
            scored_jobs,
            top_n=self._top_companies,
            target_companies=target_companies,
        )

        top_jobs = scored_jobs[:self._top_jobs]
        if not internship_only:
            companies, top_jobs = self._ensure_job_types_visible(
                scorer, scored_jobs, companies, top_jobs, target_companies,
            )

        return MatchResult(
            keywords      = keywords,
            total_jobs    = len(jobs),
            top_jobs      = top_jobs,
            top_companies = companies,
            raw_jobs      = jobs,
            search_terms  = search_terms,
            inferred_role = inferred_role,
        )