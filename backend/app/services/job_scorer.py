# FILE LOCATION: app/services/job_scorer.py
"""
PURPOSE
-------
This module scores each job listing pulled from the job-search API
against a user's parsed resume, then ranks companies based on those
scores. It's the "matching engine" that turns a raw list of job
postings into a ranked list of "how well does this job fit this
resume?" results.

NOTE ON NAMING: the module docstring below (original, unmodified)
refers to "jsearch job listing", but the actual import is
`JobListing` from `app.services.jsearch_client` — so at the time this
was written the job data source may have been swapped from Adzuna to
JSearch without the docstring being updated. Worth double-checking
which API is actually in use if this causes confusion later.

Scoring breakdown (totals 100 pts):
  ┌──────────────────────────────────────┬────────┐
  │ Component                            │ Weight │
  ├──────────────────────────────────────┼────────┤
  │ Keyword overlap (resume → job desc)  │  30 %  │
  │ Skills match (skills_block → title   │  30 %  │
  │   + description)                     │        │
  │ Semantic similarity (embedding-based)│  20 %  │
  │ Keywords matched across API queries  │  10 %  │
  │ Title relevance (summary keywords)   │  10 %  │
  └──────────────────────────────────────┴────────┘

HYBRID SCORING (added this revision)
--------------------------------------
The first 4 components are unchanged from before: pure TF-IDF-style
token/set intersection — deterministic, explainable, zero external
dependency. That's still true, and still the majority (80%) of the
total score.

The new "Semantic similarity" component is the one exception: it uses
a local embedding model (app/services/embedding_service.py — BERT-
family, no external API call) to compare the resume/target-JD text
against the job's text as WHOLE PIECES OF MEANING rather than token
sets. This is what the previous rule-based-only design structurally
couldn't do — a job that says "containerization pipeline experience"
and a resume that says "built and deployed Docker/Kubernetes
services" share almost no literal tokens, but mean nearly the same
thing.

It's deliberately kept as its OWN separate, clearly-labeled component
rather than blended invisibly into the other 4 — same reasoning as
embedding_service.py's module docstring: a rule-based score you can
point to specific matched words for stays auditable; folding a cosine
number into it silently would not. `ScoredJob.semantic_similarity`
also exposes the raw 0–1 similarity (not just its point contribution)
for that same transparency.

It fails soft: if the local embedding model isn't available on this
machine, `_semantic_score` returns 0 points and the other 4 components
(80% of the weight) are completely unaffected — job ranking still
works, just without that one signal.

HOW IT FITS INTO THE PROGRAM
-----------------------------
- Takes a `ParsedResume` (from `app.models.schemas`, presumably built
  by the resume-parsing step elsewhere in the app) and a list of
  `JobListing` objects (from `app.services.jsearch_client`, i.e. the
  job-search API client).
- Produces `ScoredJob` objects (one per listing) and can further roll
  those up into `CompanyMatch` objects (one per company, aggregating
  all of that company's scored jobs).
- Downstream code (likely an API route or UI layer) is expected to
  call `JobScorer(resume, keywords).score_all(jobs)` to get a ranked
  list of jobs, and/or `JobScorer.rank_companies(...)` to get a
  ranked list of companies.

SCORING METHOD (in plain terms)
---------------------------------
4 of the 5 components are intentionally simple, keyword/set-based
matching (not a machine-learning similarity model); the 5th
(semantic similarity) is. Each component independently produces a
0-to-max score, and they're summed for a 0-100 total:
  1. Keyword overlap  (0-30) — raw text-vs-text token overlap.
  2. Skills match      (0-30) — explicit skills list vs job text.
  3. Semantic similarity (0-20) — embedding cosine similarity between
                                  resume/target-JD and job text.
  4. API match          (0-10) — how many of the search keywords used
                                  to originally find this job actually
                                  matched it.
  5. Title relevance    (0-10) — resume summary/skills vs job title.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from app.models.schemas import ParsedResume
from app.services.jsearch_client import JobListing
from app.services import embedding_service
from app.services.keyword_extractor import _parse_skills_block, alias_variants

logger = logging.getLogger("aura")


# ─────────────────────────────────────────────
# RESULT MODEL
# ─────────────────────────────────────────────

@dataclass
class ScoredJob:
    """A single job listing plus its computed score breakdown."""
    job:              JobListing
    total_score:      float          # 0–100
    keyword_score:    float          # 0–30
    skills_score:     float          # 0–30
    semantic_score:   float          # 0–20
    api_match_score:  float          # 0–10
    title_score:      float          # 0–10
    matched_skills:   List[str] = field(default_factory=list)
    matched_keywords: List[str] = field(default_factory=list)
    # Raw embedding cosine similarity in [0, 1], BEFORE scaling to the
    # 0-20 point range — kept alongside semantic_score for transparency
    # ("this job is 78% semantically similar" reads better in a UI
    # tooltip than "15.6 points"). 0.0 whenever the embedding model
    # wasn't available for this job (see _semantic_score).
    semantic_similarity: float = 0.0


@dataclass
class CompanyMatch:
    """Aggregated scoring for all of a single company's job listings."""
    company:          str
    avg_score:        float
    top_score:        float
    job_count:        int
    top_job:          ScoredJob
    all_jobs:         List[ScoredJob] = field(default_factory=list)
    # True if this company's name matched one of the user's requested
    # target companies. Doesn't affect the underlying score — used only
    # to pin/flag the company so target-company picks aren't buried
    # under higher-scoring companies the user never asked about.
    targeted:         bool = False


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────

def _normalize(text: str) -> set:
    """Lowercase token set from a string, 3+ char alphanum tokens only.

    Used to turn free-form text (resume text, job descriptions/titles)
    into a comparable "bag of words" set for overlap calculations.
    Allows +, #, and . inside tokens so things like "c++", "c#", and
    "node.js" survive as single tokens instead of being split apart.
    """
    return set(re.findall(r"[a-z][a-z0-9\+\#\.]{2,}", text.lower()))


def _skill_tokens(skills_block: str) -> List[str]:
    """Split skills block into individual skill strings (preserves multi-word).

    Unlike `_normalize`, this keeps multi-word skills (e.g. "project
    management") intact as single list entries, splitting only on
    common delimiters (commas, pipes, bullets, newlines, slashes).
    """
    parts = re.split(r"[,|•\n/]+", skills_block)
    return [p.strip().lower() for p in parts if p.strip() and len(p.strip()) > 1]


def _skill_pattern(skill: str) -> "re.Pattern":
    """
    Word-boundary regex for one resume skill, covering its known aliases.

    Replaces a bare `skill in job_text` substring test, which treated short
    skills as matches inside unrelated words ("ai" in "maintain", "ui" in
    "build", "cd" in "medical") and missed "ReactJS" vs "React.js".
    """
    alts = []
    for v in sorted(alias_variants(skill), key=len, reverse=True):
        e = re.escape(v).replace(r"\ ", r"[\s\-]+").replace(r"\-", r"[\s\-]?")
        if v.isalpha() and len(v) >= 4:
            e += "s?"
        alts.append(e)
    return re.compile(r"(?<![a-z0-9])(?:" + "|".join(alts) + r")(?![a-z0-9])")


def _resume_skill_list(skills_block: str) -> List[str]:
    """Skills from the skills block: labels stripped ("Languages: Python" ->
    "Python"), CI/CD kept whole, sentence fragments dropped (>4 words), and
    aliases collapsed so "React" + "ReactJS" count once."""
    out, seen = [], set()
    for item in _parse_skills_block(skills_block or ""):
        s = item.lower().strip()
        if len(s) < 2 or len(s) > 40 or len(s.split()) > 4:
            continue
        variants = alias_variants(s)
        if seen & variants:
            continue
        seen |= variants
        out.append(s)
    return out


_TITLE_STOPWORDS = {"and", "the", "for", "of", "senior", "junior", "lead", "sr", "jr", "i", "ii", "iii"}


def _title_words(title: str) -> set:
    """
    Comparable word set for a job TITLE. Unlike `_normalize` it keeps 2-letter
    words ("qa", "ui", "ux", "ai") and folds spelling variants so that
    "Front-End Developer" == "Frontend Developer".
    """
    t = (title or "").lower()
    for a, b in (("front-end", "frontend"), ("back-end", "backend"),
                 ("full-stack", "fullstack"), ("full stack", "fullstack")):
        t = t.replace(a, b)
    return {w for w in re.findall(r"[a-z][a-z0-9+#]*", t) if w not in _TITLE_STOPWORDS}


# ─────────────────────────────────────────────
# SCORER
# ─────────────────────────────────────────────

class JobScorer:
    """Scores and ranks job listings against a single parsed resume."""

    def __init__(
        self,
        resume: ParsedResume,
        keywords: List[str],
        target_description: Optional[str] = None,
        target_job: str = "",
        search_terms: Optional[List[str]] = None,
        target_jobs: Optional[List[str]] = None,
    ):
        self.resume   = resume
        self.keywords = [kw.lower() for kw in keywords]

        # The queries actually sent to JSearch (role + skill combos, company
        # queries...). Used as the denominator of the API-match component so
        # it measures "queries that returned this job" rather than comparing
        # against keywords that were never searched. None = old behaviour.
        self.search_terms = list(search_terms) if search_terms else None

        # The (IT) job title the user picked on the upload form. Used by
        # _title_score so listings whose title matches it rank first.
        self.target_title_words = _title_words(target_job)

        # Several titles can be selected on the upload form. A listing earns the
        # title boost from whichever chosen title it matches best. Falls back to
        # the single `target_job` when `target_jobs` isn't given.
        title_list = [t for t in (target_jobs or []) if t and t.strip()] or ([target_job] if target_job else [])
        self.target_title_sets = [w for w in (_title_words(t) for t in title_list) if w]

        # Pre-compute resume token sets once so each per-job scoring
        # call below doesn't have to redo this work.
        self.resume_tokens  = _normalize(resume.raw_text)
        self.skills_list    = _resume_skill_list(resume.skills_block or "")
        self._skill_patterns = [(s, _skill_pattern(s)) for s in self.skills_list]
        self.skills_tokens  = _normalize(resume.skills_block or "")
        self.summary_tokens = _normalize(resume.summary_block or "")

        # Optional user-pasted target job description. When present, the
        # keyword component below blends resume-overlap with overlap
        # against this specific JD, so a job listing that actually
        # matches what the user says they're targeting outscores one
        # that only happens to echo their resume's own wording.
        self.target_description = target_description or ""
        self.target_tokens = _normalize(self.target_description)

        # ── Semantic scoring setup ──────────────────────────────────
        # Same "what does the user actually want" priority as the
        # keyword blend above: prefer the target description as the
        # comparison text when given, otherwise fall back to the full
        # resume text.
        self._semantic_compare_text = self.target_description or (resume.raw_text or "")

        # Embed the comparison text ONCE per JobScorer instance (i.e.
        # once per resume analysis), not once per job — score_all()
        # below may score dozens of jobs, and re-embedding the SAME
        # resume/target text for every single one would be pure waste.
        # None if embeddings aren't available or the text is empty;
        # every semantic call checks for that and degrades to 0 points.
        self._semantic_compare_embedding: Optional[List[float]] = None
        if self._semantic_compare_text.strip() and embedding_service.is_available():
            try:
                self._semantic_compare_embedding = embedding_service.embed_one(
                    self._semantic_compare_text
                )
            except Exception as exc:
                logger.warning("Could not embed resume/target text for semantic scoring: %s", exc)

        # Populated by _precompute_job_embeddings() (called from
        # score_all) with one embedding per job, keyed by job_id — lets
        # _semantic_score() do a plain dict lookup per job instead of
        # triggering N separate embedding calls. Falls back to an
        # on-the-fly single embedding inside _semantic_score() for
        # callers that use score_job() directly without going through
        # score_all() first.
        self._job_embeddings: Dict[str, List[float]] = {}

    # ── Batch embedding precompute ───────────────────────────────────

    def _precompute_job_embeddings(self, jobs: List[JobListing]) -> None:
        """
        Embeds every job's title+description in ONE batched call to the
        embedding model, instead of one call per job. Batching is
        significantly faster than the equivalent loop of individual
        calls — the model amortizes overhead across the batch — so this
        matters when score_all() is scoring dozens of jobs at once
        (the common case; job_matcher.py routinely fetches 20-100+ jobs
        per analysis).

        No-ops (leaves self._job_embeddings empty) if the semantic
        comparison embedding itself couldn't be computed, or if the
        embedding model isn't available — _semantic_score() checks for
        both and degrades to 0 points either way, so skipping this is
        always safe, just less complete.
        """
        if self._semantic_compare_embedding is None:
            return

        texts, job_ids = [], []
        for job in jobs:
            job_text = (job.title + " " + job.description).strip()
            if job_text:
                texts.append(job_text)
                job_ids.append(job.job_id)

        if not texts:
            return

        try:
            vectors = embedding_service.embed(texts)
        except Exception as exc:
            logger.warning("Batch job embedding failed, semantic scores will be skipped: %s", exc)
            return

        self._job_embeddings = dict(zip(job_ids, vectors))

    # ── Component scores ─────────────────────

    def _keyword_score(self, job: JobListing) -> tuple[float, List[str]]:
        """
        30 pts — how many resume (and, if given, target-JD) tokens appear
        in the job description.

        Without a target job description: 100% of this component (30 pts)
        comes from resume-vs-job overlap, same as before.

        With a target job description: split ~18.75 pts resume-overlap /
        ~11.25 pts target-JD-overlap (same 60/40-ish ratio as before this
        revision, just rescaled from a 40-pt budget to a 30-pt one — see
        the module docstring's weight table), so a listing that matches
        the role the user is actually going after outweighs one that
        only echoes their resume's general vocabulary.
        """
        job_tokens = _normalize(job.description + " " + job.title)
        if not job_tokens:
            return 0.0, []

        resume_matched = self.resume_tokens & job_tokens
        resume_ratio = len(resume_matched) / max(len(self.resume_tokens), 1)

        if not self.target_tokens:
            score = min(resume_ratio * 150, 30.0)
            return round(score, 2), sorted(resume_matched)[:10]

        target_matched = self.target_tokens & job_tokens
        target_ratio = len(target_matched) / max(len(self.target_tokens), 1)

        resume_score = min(resume_ratio * 93.75, 18.75)  # ~20% overlap = full 18.75
        target_score = min(target_ratio * 75, 11.25)     # ~15% overlap = full 11.25
        score = round(resume_score + target_score, 2)

        matched = sorted(resume_matched | target_matched)[:10]
        return score, matched

    def _skills_score(self, job: JobListing) -> tuple[float, List[str]]:
        """
        30 pts — explicit skills from skills_block found in job title + description.
        Each matched skill = 30 / total_skills pts, capped at 30.
        """
        if not self.skills_list:
            return 0.0, []

        job_text = (job.title + " " + job.description).lower()
        # Word-boundary, alias-aware check (see _skill_pattern) — is this
        # skill, or a known spelling of it, in the title+description?
        matched = [s for s, pat in self._skill_patterns if pat.search(job_text)]
        ratio = len(matched) / max(len(self.skills_list), 1)
        score = min(ratio * 30, 30.0)
        return round(score, 2), matched

    def _semantic_score(self, job: JobListing) -> tuple[float, float]:
        """
        20 pts — embedding-based semantic similarity between the resume
        (or target job description, when given) and this job's title +
        description, as whole pieces of meaning rather than token sets.

        This is the one component that catches matches the other 4
        structurally cannot: e.g. a job describing "containerization
        pipeline experience" against a resume describing "built and
        deployed Docker/Kubernetes services" — almost no shared tokens,
        but the same underlying skill.

        Returns (points_0_to_20, raw_similarity_0_to_1). The raw
        similarity is also what gets stored on ScoredJob.semantic_similarity
        for transparency, separate from the scaled point value.

        Fails soft to (0.0, 0.0) — a missing/unavailable embedding
        model, an empty comparison text, or any embedding error all
        degrade to "no semantic signal for this job" rather than
        raising, so this can never break score_job()/score_all().
        """
        if self._semantic_compare_embedding is None:
            return 0.0, 0.0

        job_text = (job.title + " " + job.description).strip()
        if not job_text:
            return 0.0, 0.0

        # Prefer the batch-precomputed embedding (see
        # _precompute_job_embeddings, called by score_all before
        # scoring starts) — falls back to embedding this one job on
        # the fly for callers using score_job() standalone.
        job_vector = self._job_embeddings.get(job.job_id)
        if job_vector is None:
            try:
                job_vector = embedding_service.embed_one(job_text)
            except Exception as exc:
                logger.warning("Semantic scoring failed for job '%s': %s", job.title, exc)
                return 0.0, 0.0

        similarity = embedding_service.cosine_similarity(self._semantic_compare_embedding, job_vector)
        # Clamp defensively — cosine similarity should land in [0, 1]
        # for this model/domain in practice, but never let a stray
        # value outside that range produce an out-of-range score.
        similarity = max(0.0, min(1.0, similarity))
        return round(similarity * 20, 2), round(similarity, 4)

    def _api_match_score(self, job: JobListing) -> float:
        """
        10 pts — how many of the queried keywords matched this job via jsearch.
        (keywords_matched is populated by the jsearch during dedup.)
        """
        if not self.keywords and not self.search_terms:
            return 0.0
        # Denominator is capped at 5, so searches with many queries don't
        # unfairly dilute this component. Prefer the real query list.
        n_queries = len(self.search_terms) if self.search_terms else len(self.keywords)
        ratio = len(job.keywords_matched) / max(min(n_queries, 5), 1)
        return round(min(ratio * 10, 10.0), 2)

    def _title_score(self, job: JobListing) -> float:
        """
        10 pts — how many summary/experience keywords appear in the job title,
        or (when a target job title was chosen) how much of that title the
        listing's title contains — whichever is higher.
        """
        title_tokens = _normalize(job.title)
        # Combines both the resume's summary tokens AND skills tokens
        # into one set before comparing against the job title.
        overlap = (self.summary_tokens | self.skills_tokens) & title_tokens
        ratio = len(overlap) / max(len(title_tokens), 1)
        score = min(ratio * 30, 10.0)

        # Target-job boost: if the user picked a target title, a listing
        # whose title contains that title's words earns up to the full 10 pts
        # (e.g. target "Backend Developer" vs "Senior Backend Developer" = 10).
        if self.target_title_sets:
            job_words = _title_words(job.title)
            hit = max(len(words & job_words) / len(words) for words in self.target_title_sets)
            score = max(score, hit * 10)

        return round(min(score, 10.0), 2)

    # ── Score a single job ───────────────────

    def score_job(self, job: JobListing) -> ScoredJob:
        """Runs all 5 scoring components for one job and sums them into a total."""
        kw_score,   matched_kw     = self._keyword_score(job)
        sk_score,   matched_skills = self._skills_score(job)
        sem_score,  similarity     = self._semantic_score(job)
        api_score                  = self._api_match_score(job)
        ti_score                   = self._title_score(job)

        total = round(kw_score + sk_score + sem_score + api_score + ti_score, 2)

        return ScoredJob(
            job                  = job,
            total_score          = total,
            keyword_score        = kw_score,
            skills_score         = sk_score,
            semantic_score       = sem_score,
            api_match_score      = api_score,
            title_score          = ti_score,
            matched_skills       = matched_skills,
            matched_keywords     = matched_kw,
            semantic_similarity  = similarity,
        )

    # ── Score all jobs ───────────────────────

    def score_all(self, jobs: List[JobListing]) -> List[ScoredJob]:
        """Scores every job in the list and returns them sorted best-first."""
        # Batch-embed every job up front so _semantic_score() below does
        # plain dict lookups instead of N individual embedding calls —
        # see _precompute_job_embeddings' docstring.
        self._precompute_job_embeddings(jobs)
        scored = [self.score_job(j) for j in jobs]
        return sorted(scored, key=lambda s: s.total_score, reverse=True)

    # ── Aggregate to company ranking ─────────

    @staticmethod
    def rank_companies(
        scored_jobs: List[ScoredJob],
        top_n: int = 10,
        target_companies: Optional[List[str]] = None,
    ) -> List[CompanyMatch]:
        """
        Groups scored jobs by company.
        Company score = weighted average: 60% top_score + 40% avg_score

        If target_companies is given (the companies the user explicitly
        said they're interested in), those companies are:
          - flagged via CompanyMatch.targeted, and
          - guaranteed a slot in the returned top_n list, sorted ahead of
            non-targeted companies regardless of score — the user asked
            about them by name, so they shouldn't get crowded out by an
            unrelated company that merely scored a few points higher.
        Companies the user targeted but for which no jobs were found at
        all simply won't appear here (there's nothing to show); that's
        expected since this only aggregates from scored_jobs.
        """
        target_set = {c.strip().lower() for c in (target_companies or []) if c.strip()}

        # Group all scored jobs under their company name. Jobs with a
        # blank/missing company name are bucketed under "Unknown".
        by_company: Dict[str, List[ScoredJob]] = {}
        for sj in scored_jobs:
            name = sj.job.company.strip() or "Unknown"
            by_company.setdefault(name, []).append(sj)

        companies = []
        for company, jobs in by_company.items():
            scores   = [j.total_score for j in jobs]
            avg      = sum(scores) / len(scores)
            top      = max(scores)
            best_job = max(jobs, key=lambda j: j.total_score)

            companies.append(CompanyMatch(
                company   = company,
                avg_score = round(avg, 2),
                top_score = round(top, 2),
                job_count = len(jobs),
                top_job   = best_job,
                all_jobs  = sorted(jobs, key=lambda j: j.total_score, reverse=True),
                targeted  = company.strip().lower() in target_set,
            ))

        # Sort by: targeted companies first, then the existing weighted
        # score formula (60% top_score + 40% avg_score) descending.
        companies.sort(
            key=lambda c: (c.targeted, 0.6 * c.top_score + 0.4 * c.avg_score),
            reverse=True,
        )
        return companies[:top_n]