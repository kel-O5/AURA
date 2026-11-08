# app/services/skill_matcher.py
"""
Shared semantic-aware skill/term matching.

Used by target_job_matcher.py and resume_enricher.py wherever the code
currently does a plain `term.lower() in some_text` substring check to
decide whether a resume "has" a skill.

WHY THIS EXISTS
----------------
Substring matching treats "React.js", "ReactJS", and "React framework"
as three unrelated tokens, even though they're the same skill. That's
fine when the resume literally contains the term (fast, free, always
correct) but silently produces false "missing" gaps whenever the resume
uses a different surface form of the same skill.

This module keeps substring matching as the FIRST and PRIMARY check —
it's free, has zero false positives, and covers the large majority of
real matches — and only reaches for the embedding model
(embedding_service.py) on the subset of terms that don't substring-
match. If the embedding model isn't available
(see embedding_service.is_available()), everything degrades gracefully
back to today's substring-only behavior — this module is additive,
never a hard dependency of any gap-detection path that already works.

WHY WE COMPARE AGAINST "RESUME PHRASES", NOT THE WHOLE RESUME TEXT
---------------------------------------------------------------------
Embedding a skill term ("Kubernetes") against the resume's entire raw
text as one giant string produces a near-meaningless similarity number
— a long document embeds toward its overall topic, not toward any one
skill mentioned once in passing. Instead we split the resume into
short candidate phrases (skills_block entries, plus short skill-shaped
lines from the rest of the resume) and compare the term against EACH
phrase, keeping the best match. That's the same granularity a human
reviewer uses when scanning a resume for a specific skill.

CALL PATTERN
-------------
Every existing call site already lowercases its haystack before doing
`term in haystack` — this module keeps that convention. Pass the
already-lowercased `resume_text` (or skills-only haystack) exactly as
you were passing it before; `skills_block` / `raw_text` are additional,
ORIGINAL-CASE fields used only to build candidate phrases for the
semantic fallback (mixed-case terms like "PostgreSQL" survive better
as embedding input than a fully lowercased blob).
"""

import logging
import re
from dataclasses import dataclass
from typing import Optional, Sequence

from app.services import embedding_service

logger = logging.getLogger("aura")

# Cosine similarity threshold above which a resume phrase is considered
# "the same skill" as the term we're looking for. Tuned conservatively —
# too low and "Python" starts matching "PySpark"; too high and it barely
# catches anything substring matching wouldn't already get. Kept as a
# single constant so it can be retuned in one place once there's real
# before/after data to look at.
SKILL_MATCH_THRESHOLD = 0.78

# Skip the semantic fallback for terms shorter than this — short tokens
# ("R", "Go", "C", "UX") are too ambiguous for embedding similarity to
# say anything meaningful about, and substring matching is already
# reliable for terms this short.
MIN_TERM_LEN_FOR_SEMANTIC = 4

# Cap how many resume phrases a single gap-check call will compare
# terms against. Phrases are deduped and length-filtered before this
# cap applies, so it rarely bites for a normal resume, but it stops a
# pathological skills_block/raw_text from turning one request into
# hundreds of embedding calls.
MAX_RESUME_PHRASES = 60

_PHRASE_SPLIT_RE = re.compile(r"[,\n/|•·▪◦\-]+")


@dataclass
class SkillMatch:
    present: bool
    matched_via: Optional[str] = None       # "exact" | "semantic" | None
    matched_phrase: Optional[str] = None    # the resume phrase that matched (semantic only)
    similarity: Optional[float] = None      # cosine similarity (semantic only)


def _extract_candidate_phrases(
    skills_block: Optional[str],
    raw_text: Optional[str],
) -> list[str]:
    """
    Builds a deduped list of short candidate phrases from the resume to
    compare a skill term against individually. Prefers skills_block
    entries (already skill-shaped, e.g. "React.js", "AWS Lambda") and
    tops up with short lines from raw_text so skills mentioned only in
    the experience section still get a chance to match.
    """
    phrases: list[str] = []
    seen: set[str] = set()

    def _add(candidate: str) -> None:
        c = candidate.strip(" .;:")
        if not c or len(c) > 60:
            return
        key = c.lower()
        if key in seen:
            return
        seen.add(key)
        phrases.append(c)

    if skills_block:
        for part in _PHRASE_SPLIT_RE.split(skills_block):
            _add(part)

    if raw_text and len(phrases) < MAX_RESUME_PHRASES:
        for line in raw_text.split("\n"):
            if len(phrases) >= MAX_RESUME_PHRASES:
                break
            line = line.strip()
            # Only short, skill-shaped lines — not full sentences from
            # the experience/summary blocks, which would just embed
            # toward "generic resume prose" rather than any one skill.
            if 0 < len(line) <= 60 and len(line.split()) <= 6:
                _add(line)

    return phrases[:MAX_RESUME_PHRASES]


def _best_semantic_match(term_l: str, candidates: list[str]) -> tuple[Optional[str], float]:
    best_phrase: Optional[str] = None
    best_score = 0.0
    for phrase in candidates:
        try:
            score = embedding_service.cached_semantic_similarity(term_l, phrase.lower())
        except Exception as exc:
            logger.warning("Semantic skill match failed for '%s' vs '%s': %s", term_l, phrase, exc)
            continue
        if score > best_score:
            best_score = score
            best_phrase = phrase
    return best_phrase, best_score


def skills_present(
    terms: Sequence[str],
    resume_text: str,
    skills_block: Optional[str] = None,
    raw_text: Optional[str] = None,
) -> dict[str, SkillMatch]:
    """
    Checks a list of terms against one resume and returns
    {term: SkillMatch}. This is the primary entry point — prefer it
    over calling skill_present() in a loop whenever you have more than
    one term, since candidate-phrase extraction and the availability
    check happen ONCE for the whole batch rather than per term.

    `resume_text` should be the same lowercased haystack every existing
    call site already builds (e.g. `(resume.raw_text or "").lower()`).
    `skills_block` / `raw_text` are the resume's ORIGINAL-CASE fields,
    used only to build candidate phrases for terms that miss the
    substring check.
    """
    results: dict[str, SkillMatch] = {}
    remaining: list[str] = []

    # Step 1 (always, all terms): free substring check. Anything that
    # hits here never touches the embedding model.
    for term in terms:
        term_l = term.strip().lower()
        if term_l and term_l in resume_text:
            results[term] = SkillMatch(present=True, matched_via="exact")
        else:
            remaining.append(term)

    if not remaining:
        return results

    # Step 2 (only for terms that missed step 1): semantic fallback.
    # Availability check and candidate-phrase extraction happen once
    # for the whole remaining batch, not once per term.
    try:
        available = embedding_service.is_available()
    except Exception as exc:
        logger.warning("Embedding model unavailable for skill matching: %s", exc)
        available = False

    candidates = _extract_candidate_phrases(skills_block, raw_text) if available else []

    # Batch the semantic step: embed every eligible term and every candidate
    # phrase once, then score all pairs with a single matrix multiply
    # (instead of one slow embedding comparison per term/phrase pair).
    eligible = [t for t in remaining if len(t.strip()) >= MIN_TERM_LEN_FOR_SEMANTIC]
    best_by_term: dict = {}
    if candidates and eligible:
        try:
            matches = embedding_service.best_matches(
                [t.strip().lower() for t in eligible],
                [p.lower() for p in candidates],
            )
            for term, (idx, score) in zip(eligible, matches):
                best_by_term[term] = (candidates[idx] if idx is not None else None, score)
        except Exception as exc:
            logger.warning("Batched semantic skill match failed: %s", exc)

    for term in remaining:
        best_phrase, best_score = best_by_term.get(term, (None, 0.0))
        if best_phrase is not None and best_score >= SKILL_MATCH_THRESHOLD:
            results[term] = SkillMatch(
                present=True,
                matched_via="semantic",
                matched_phrase=best_phrase,
                similarity=round(best_score, 3),
            )
        else:
            results[term] = SkillMatch(present=False)

    return results


def skill_present(
    term: str,
    resume_text: str,
    skills_block: Optional[str] = None,
    raw_text: Optional[str] = None,
) -> SkillMatch:
    """
    Single-term convenience wrapper around skills_present(). Prefer
    skills_present() directly when checking more than one term against
    the same resume — it does the availability check and phrase
    extraction once instead of once per call.
    """
    return skills_present([term], resume_text, skills_block, raw_text)[term]