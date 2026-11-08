# ==============================================================================
# FILE: app/services/resume_enricher.py
# ==============================================================================

import re
import math
from typing import Optional

from app.models.schemas import ParsedResume
from app.services.keyword_extractor import extract_keywords_from_text, extract_skill_terms_from_posting
from app.services.skill_matcher import skills_present

# pyspellchecker is an optional dependency for the spelling check below
# (add "pyspellchecker" to requirements.txt). If it isn't installed, the
# spelling check is skipped gracefully rather than crashing the pipeline.
try:
    from spellchecker import SpellChecker as _SpellChecker  # type: ignore[import-not-found]
except ImportError:
    _SpellChecker = None


# ─────────────────────────────────────────────────────────────────────────────
# SKILL TAXONOMY
# Maps broad skill categories → representative keywords.
# Used for skill gap detection: if none of a category's keywords appear in the
# resume's skills_block, we flag it as missing/optional.
# ─────────────────────────────────────────────────────────────────────────────

SKILL_TAXONOMY = {
    "Communication":       ["communication", "presentation", "writing", "verbal", "interpersonal", "negotiation"],
    "Leadership":          ["leadership", "management", "mentoring", "coaching", "team lead", "director", "supervise"],
    "Project Management":  ["project management", "agile", "scrum", "kanban", "jira", "pmp", "planning", "roadmap"],
    "Data Analysis":       ["data analysis", "sql", "excel", "tableau", "power bi", "statistics", "analytics", "pandas"],
    "Programming":         ["python", "javascript", "java", "c++", "typescript", "golang", "ruby", "php", "rust"],
    "Cloud & DevOps":      ["aws", "azure", "gcp", "docker", "kubernetes", "ci/cd", "terraform", "devops", "linux"],
    "Machine Learning":    ["machine learning", "deep learning", "tensorflow", "pytorch", "nlp", "bert", "scikit", "ai"],
    "Web Development":     ["react", "vue", "angular", "node", "html", "css", "rest", "api", "fastapi", "django"],
    "Design":              ["figma", "sketch", "ux", "ui", "design", "wireframe", "prototype", "adobe"],
    "Soft Skills":         ["problem solving", "critical thinking", "collaboration", "adaptability", "creativity"],
    "Database":            ["postgresql", "mysql", "mongodb", "redis", "database", "orm", "nosql", "sqlite"],
    "Security":            ["cybersecurity", "penetration testing", "owasp", "encryption", "soc", "compliance"],
}

# Minimum skills found in skills_block to consider "Skills" dimension strong
SKILLS_STRONG_THRESHOLD = 6
SKILLS_ADEQUATE_THRESHOLD = 3

# Optimal resume length range (words)
WORD_COUNT_MIN = 400
WORD_COUNT_MAX = 800
WORD_COUNT_IDEAL_LOW = 450
WORD_COUNT_IDEAL_HIGH = 700

# Regex patterns for quantified achievements (numbers, %, $, multipliers)
IMPACT_PATTERNS = [
    r"\b\d+\s*%",                         # "20%", "35 %"
    r"\$\s*\d[\d,\.]*[kKmMbB]?\b",        # "$500K", "$1.2M"
    r"\b\d[\d,]*\s*(users|customers|clients|people|employees|members|projects|products|systems|applications|countries|regions|markets)",
    r"\b(increased|decreased|reduced|improved|grew|boosted|cut|saved|generated|delivered|launched|scaled)\b.{0,40}\b\d+",
    r"\bx\d+\b|\b\d+x\b",                 # "3x", "10x"
    r"\b(led|managed|directed|oversaw)\b.{0,30}\bteam\b.{0,20}\b\d+",
    r"\b\d+\s*(million|billion|thousand|hundred)\b",
]

# Grammar / style anti-patterns (LINGUISTIC CLARITY — sentence-level wording)
GRAMMAR_CHECKS = [
    {
        "pattern": r"\b(responsible for|in charge of|duties included|tasked with)\b",
        "type": "Passive",
        "text": "Replace weak phrases like 'responsible for' with strong action verbs (led, built, designed, delivered).",
    },
    {
        "pattern": r"\b(is|are|am|was|were)\s+\w+ing\b",
        "type": "Tense",
        "text": "Use simple past tense for past roles — 'developed' not 'was developing'.",
    },
    {
        "pattern": r"\b(i |i'm |i've |i'll )",
        "type": "Clarity",
        "text": "Remove first-person pronouns ('I', 'I've') — resumes are written in implied first person.",
    },
    {
        "pattern": r"(.)\1{3,}",
        "type": "Brevity",
        "text": "Avoid filler or repeated characters — keep every word purposeful.",
    },
    {
        "pattern": r"\b(very|really|quite|rather|somewhat|extremely|incredibly)\s+\w+",
        "type": "Brevity",
        "text": "Cut vague intensifiers ('very', 'really', 'extremely') — use precise, specific language instead.",
    },
    {
        "pattern": r"\b(hardworking|passionate|motivated|enthusiastic|dynamic|results.driven|detail.oriented|self.starter|team player|go.getter)\b",
        "type": "Clarity",
        "text": "Remove resume clichés like 'hardworking' or 'passionate' — show these traits through accomplishments instead.",
    },
]

# Bullet-point glyphs we recognize as "this line is a bullet".
_BULLET_GLYPHS = ["•", "◦", "▪", "‣", "●", "-", "*", "–", "—"]
_BULLET_LINE_RE = re.compile(r"^\s*([•◦▪‣●\-*–—]|\d{1,2}[.)])\s+\S")

# Date-format families. If a resume mixes 2+ of these, dates read inconsistently.
_DATE_FORMATS = {
    "Month Year (e.g. 'Jan 2020')": re.compile(
        r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}\b", re.IGNORECASE
    ),
    "MM/YYYY or MM-YYYY": re.compile(r"\b\d{1,2}[/\-]\d{4}\b"),
    "YYYY–YYYY range": re.compile(r"\b\d{4}\s*[-–—]\s*(?:\d{4}|present|current)\b", re.IGNORECASE),
}

# A sentence longer than this (in words) is hard to scan at a glance.
MAX_READABLE_SENTENCE_WORDS = 35
# A single line/bullet longer than this (in chars) with no break suggests a wall-of-text bullet.
MAX_READABLE_LINE_CHARS = 280
# A resume below this word count doesn't have enough text for the visual-flow
# and readability checks to say anything meaningful — flag that explicitly
# instead of silently falling through to a false "no issues" result.
MIN_WORDS_FOR_READABILITY_CHECK = 120

# ─────────────────────────────────────────────────────────────────────────────
# CONTACT INFO PATTERNS
# ─────────────────────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
_PHONE_RE = re.compile(r"(\+?\d[\d\-\.\s\(\)]{7,}\d)")
_LINKEDIN_RE = re.compile(r"linkedin\.com/in/[^\s]+", re.IGNORECASE)
_URL_RE = re.compile(r"(https?://|www\.)[^\s]+", re.IGNORECASE)

# ─────────────────────────────────────────────────────────────────────────────
# SECTION ORDER
# ATS-friendly convention: Summary -> Experience -> Education -> Skills.
# Detected via the earliest position of any representative keyword for each
# section within raw_text (a lightweight proxy — resume_enricher only has
# ParsedResume's extracted blocks, not the parser's original header order).
# ─────────────────────────────────────────────────────────────────────────────

_SECTION_ORDER_KEYWORDS = {
    "summary":    ["summary", "objective", "professional profile"],
    "experience": ["experience", "employment", "work history"],
    "education":  ["education", "academic background"],
    "skills":     ["skills", "core competencies", "technical skills"],
}
_IDEAL_SECTION_ORDER = ["summary", "experience", "education", "skills"]

# ─────────────────────────────────────────────────────────────────────────────
# EXPERIENCE ROLE SPLITTING
# Several checks below (bullet count, tense consistency, achievement ratio)
# need to reason about ONE job entry at a time rather than the whole
# experience_block as a single blob.
# ─────────────────────────────────────────────────────────────────────────────

MIN_BULLETS_PER_ROLE = 2
MAX_BULLETS_PER_ROLE = 8

# Common resume action verbs, paired present-tense / past-tense forms.
# Used for the within-role tense-consistency check — deliberately a small,
# high-confidence list (regular -ed verbs only) rather than a full NLP
# tense tagger, to keep this dependency-free and predictable.
_PRESENT_TENSE_VERBS = {
    "lead", "manage", "build", "develop", "design", "create", "own",
    "drive", "oversee", "coordinate", "analyze", "write", "run",
    "deliver", "implement", "launch", "support", "maintain", "optimize",
    "train", "mentor", "collaborate", "plan", "execute", "streamline",
    "spearhead", "facilitate", "monitor", "operate", "handle",
}
_PAST_TENSE_VERBS = {
    "led", "managed", "built", "developed", "designed", "created", "owned",
    "drove", "oversaw", "coordinated", "analyzed", "wrote", "ran",
    "delivered", "implemented", "launched", "supported", "maintained",
    "optimized", "trained", "mentored", "collaborated", "planned",
    "executed", "streamlined", "spearheaded", "facilitated", "monitored",
    "operated", "handled",
}

# Bullets opening with the same first verb this many times (or more) reads
# as repetitive rather than varied.
VERB_REPETITION_THRESHOLD = 4

# Words the spellchecker's general-English dictionary doesn't know but that
# are legitimate, common resume/tech vocabulary — excluded from spelling
# flags so real typos aren't buried under false positives.
SPELLING_WHITELIST = {
    "html", "css", "sql", "nosql", "api", "apis", "aws", "gcp", "azure",
    "devops", "cicd", "saas", "paas", "iaas", "seo", "sem", "crm", "erp",
    "kpi", "kpis", "roi", "okr", "okrs", "ux", "ui", "nlp",
    "python", "java", "javascript", "typescript", "golang", "kotlin",
    "django", "flask", "fastapi", "react", "vue", "angular", "node",
    "kubernetes", "docker", "terraform", "jenkins", "github", "gitlab",
    "jira", "figma", "sketch", "tableau", "excel", "powerpoint",
    "postgresql", "mysql", "mongodb", "redis", "graphql", "microservices",
    "tensorflow", "pytorch", "scikit", "numpy", "pandas", "linkedin",
    "onboarding", "fullstack", "frontend", "backend", "hyperparameter",
    "hyperparameters", "webhook", "webhooks", "middleware", "endpoint",
    "endpoints", "codebase", "workflow", "workflows", "dashboarding",
    "cybersecurity", "scrum", "kanban", "agile",
}


# ─────────────────────────────────────────────────────────────────────────────
# DIMENSION SCORERS
# Each returns a float 0–100.
# ─────────────────────────────────────────────────────────────────────────────

# Fixed reference vocabulary for the Keywords dimension: every term in
# SKILL_TAXONOMY, matched as a whole word. It never changes between runs, so
# the same resume always gets the same Keywords score.
_KEYWORD_REFERENCE_PATTERNS = [
    re.compile(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])")
    for term in sorted({t for terms in SKILL_TAXONOMY.values() for t in terms})
]

# Distinct reference terms a resume needs to hit for full coverage credit.
KEYWORD_COVERAGE_TARGET = 12


def _score_keywords(
    resume: ParsedResume,
    keywords: list[str],
    top_jobs: list[dict],
) -> float:
    """
    Measures how keyword-rich the resume is, using ONLY the resume itself.

    FIXED (QA: "same resume, different ATS score"): this used to compare the
    resume against the words found in the top JSearch job descriptions. Those
    postings change with the target job, the target companies, the freelance
    toggle and the day the search runs, so the same resume scored differently
    on every analysis. The ATS score is a property of the resume, so this
    dimension no longer reads `top_jobs` (the parameter is kept so callers
    don't change). How well the resume fits specific jobs is shown separately
    by the Match Score.

    1. keyword_coverage (60% weight)
       How many distinct terms from the fixed SKILL_TAXONOMY vocabulary the
       resume contains (whole-word match, no embeddings, no network).
       KEYWORD_COVERAGE_TARGET distinct terms = full credit.

    2. keyword_density (40% weight)
       Ratio of unique meaningful keywords to total word count. A keyword-rich
       resume has a high density; one padded with filler prose scores lower.
       Ideal density ~ 8-15% unique meaningful terms.
    """
    raw = resume.raw_text.lower()
    word_count = max(resume.word_count, 1)

    # -- 1. Keyword coverage against the fixed vocabulary -------------------
    hits = sum(1 for pattern in _KEYWORD_REFERENCE_PATTERNS if pattern.search(raw))
    coverage_score = min(hits / KEYWORD_COVERAGE_TARGET, 1.0) * 100

    # -- 2. Keyword density: unique meaningful terms / total words ----------
    resume_tokens = set(re.findall(r"[a-z][a-z0-9\+\#\.]{2,}", raw)) - _GENERIC_JOB_TERMS
    density = len(resume_tokens) / word_count  # typical range 0.05-0.20

    # Scale: density of 0.12+ = full 100, below 0.04 = near 0
    density_score = min(density / 0.12 * 100, 100)

    return round(coverage_score * 0.60 + density_score * 0.40, 1)


def _score_format(resume: ParsedResume) -> float:
    """
    Measures structural completeness.

    Scoring:
      - Has summary/objective block    → 20 pts
      - Has experience block           → 30 pts
      - Has skills block               → 25 pts
      - Has education block            → 15 pts
      - Has projects or certifications → 10 pts
    Total = 100.
    """
    score = 0.0
    if resume.summary_block and len(resume.summary_block.strip()) > 30:
        score += 20
    if resume.experience_block and len(resume.experience_block.strip()) > 50:
        score += 30
    if resume.skills_block and len(resume.skills_block.strip()) > 20:
        score += 25
    if resume.education_block and len(resume.education_block.strip()) > 20:
        score += 15
    if (resume.projects_block and len(resume.projects_block.strip()) > 20) or \
       (resume.certifications_block and len(resume.certifications_block.strip()) > 20):
        score += 10
    return round(score, 1)


def _score_skills(resume: ParsedResume) -> float:
    """
    Measures skills section depth.

    Scoring:
      - Number of individual skills listed (up to 80 pts, linear up to 12 skills)
      - Breadth across taxonomy categories found in skills_block (up to 20 pts)
    """
    if not resume.skills_block:
        return 10.0  # penalty for missing skills section entirely

    skills_text = resume.skills_block.lower()

    # Count individual skill entries
    parts = re.split(r"[,|•\n/\-]+", skills_text)
    skill_items = [p.strip() for p in parts if p.strip() and len(p.strip()) > 1]
    count_score = min(len(skill_items) / 12, 1.0) * 80

    # Breadth: how many taxonomy categories appear. Substring-first
    # (unchanged), with a semantic fallback per category so a
    # differently-worded skill still counts — e.g. a skills_block
    # listing "React framework" now still hits "Web Development" even
    # though none of that category's literal terms appear verbatim.
    all_taxonomy_terms = [t for terms in SKILL_TAXONOMY.values() for t in terms]
    taxonomy_matches = skills_present(
        all_taxonomy_terms,
        skills_text,
        skills_block=resume.skills_block,
        raw_text=resume.raw_text,
    )
    categories_hit = 0
    for category, terms in SKILL_TAXONOMY.items():
        if any(taxonomy_matches[term].present for term in terms):
            categories_hit += 1
    breadth_score = min(categories_hit / 4, 1.0) * 20  # 4 categories = full breadth score

    return round(count_score + breadth_score, 1)


def _score_impact(resume: ParsedResume) -> float:
    """
    Measures use of quantified, achievement-oriented language.

    Each unique impact pattern match found in experience/summary = 8 pts.
    Capped at 100.
    """
    text = " ".join(filter(None, [
        resume.experience_block,
        resume.summary_block,
        resume.projects_block,
    ])).lower()

    if not text:
        return 20.0  # base score if no experience text

    hits = 0
    for pattern in IMPACT_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        hits += len(matches)

    # Base of 20, +8 per hit up to 100
    return round(min(20 + hits * 8, 100), 1)


def _score_length(resume: ParsedResume) -> float:
    """
    Word count optimality score.
    Ideal range: 450–700 words = 100 pts.
    Outside that range, score degrades linearly.
    """
    wc = resume.word_count

    if WORD_COUNT_IDEAL_LOW <= wc <= WORD_COUNT_IDEAL_HIGH:
        return 100.0
    elif wc < WORD_COUNT_IDEAL_LOW:
        # Too short — scale from 0 at 0 words to 100 at ideal_low
        return round(max(wc / WORD_COUNT_IDEAL_LOW * 100, 10), 1)
    else:
        # Too long — penalise beyond ideal_high, floor at 40
        excess = wc - WORD_COUNT_IDEAL_HIGH
        return round(max(100 - (excess / 10), 40), 1)


# ─────────────────────────────────────────────────────────────────────────────
# SHARED HELPERS FOR RESUME-SPECIFIC TEXT EXTRACTION
# Used by both keyword scoring and the strength/improvement generators below,
# so strengths/improvements can reference the *same* terms the score is based on.
# ─────────────────────────────────────────────────────────────────────────────

_GENERIC_JOB_TERMS = {
    "the", "and", "for", "with", "this", "that", "are", "you", "will",
    "our", "have", "your", "from", "they", "been", "their", "all",
    "not", "but", "can", "who", "its", "was", "one", "more", "about",
    "into", "such", "also", "any", "some", "work", "must", "well",
    "including", "experience", "skills", "team", "role", "responsibilities",
}


def _sample_skills(skills_block: Optional[str], n: int = 4) -> list[str]:
    """Returns up to n skill names exactly as written in skills_block (deduped, order preserved)."""
    if not skills_block:
        return []
    parts = re.split(r"[,|•\n/\-]+", skills_block)
    items = [p.strip() for p in parts if p.strip() and len(p.strip()) > 1]
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.lower()
        if key not in seen:
            seen.add(key)
            out.append(item)
        if len(out) >= n:
            break
    return out


def _first_line(block: Optional[str], max_len: int = 90) -> str:
    """Returns the first non-empty line of a section block, truncated for display."""
    if not block:
        return ""
    for line in block.split("\n"):
        line = line.strip(" -•\t")
        if line:
            return line if len(line) <= max_len else line[: max_len - 3].rstrip() + "..."
    return ""


def _extract_impact_examples(text: Optional[str], max_examples: int = 2) -> list[str]:
    """Pulls real lines from the resume that contain quantified achievements."""
    if not text:
        return []
    examples: list[str] = []
    for line in text.split("\n"):
        clean = line.strip(" -•\t")
        if not clean:
            continue
        for pattern in IMPACT_PATTERNS:
            if re.search(pattern, clean, re.IGNORECASE):
                snippet = clean if len(clean) <= 140 else clean[:137].rstrip() + "..."
                if snippet not in examples:
                    examples.append(snippet)
                break
        if len(examples) >= max_examples:
            break
    return examples


def _top_job_vocab(top_jobs: Optional[list[dict]], limit: int = 10) -> set[str]:
    """Aggregate vocabulary from the user's top-matching job titles/descriptions."""
    vocab: set[str] = set()
    for job in (top_jobs or [])[:limit]:
        title_tokens = set(re.findall(r"[a-z][a-z0-9\+\#\.]{2,}", job.get("title", "").lower()))
        desc_tokens  = set(re.findall(r"[a-z][a-z0-9\+\#\.]{2,}", job.get("description", "").lower()))
        vocab |= title_tokens | desc_tokens
    return vocab - _GENERIC_JOB_TERMS


def _matched_job_terms(resume: ParsedResume, top_jobs: Optional[list[dict]], n: int = 5) -> list[str]:
    """Specific terms that appear BOTH in the resume and across top-matching job postings."""
    vocab = _top_job_vocab(top_jobs)
    if not vocab:
        return []
    raw = resume.raw_text.lower()
    matched = [term for term in vocab if term in raw]
    # Longer/more specific terms are more informative than short generic tokens
    matched.sort(key=len, reverse=True)
    return matched[:n]


def _missing_job_terms(resume: ParsedResume, top_jobs: Optional[list[dict]], n: int = 5) -> list[str]:
    """Terms frequent across top-matching jobs but absent from the resume, ranked by frequency."""
    counts: dict[str, int] = {}
    for job in (top_jobs or [])[:10]:
        title_tokens = set(re.findall(r"[a-z][a-z0-9\+\#\.]{2,}", job.get("title", "").lower()))
        desc_tokens  = set(re.findall(r"[a-z][a-z0-9\+\#\.]{2,}", job.get("description", "").lower()))
        for term in (title_tokens | desc_tokens) - _GENERIC_JOB_TERMS:
            counts[term] = counts.get(term, 0) + 1

    raw = resume.raw_text.lower()
    missing = [(term, c) for term, c in counts.items() if term not in raw and c >= 2]
    missing.sort(key=lambda t: t[1], reverse=True)
    return [term for term, _ in missing[:n]]


# ─────────────────────────────────────────────────────────────────────────────
# STRENGTH GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

def _generate_strengths(
    resume: ParsedResume,
    keywords: list[str],
    kw_score: float,
    skills_score: float,
    impact_score: float,
    format_score: float,
    top_jobs: Optional[list[dict]] = None,
) -> list[str]:
    strengths = []

    # Skills section present and rich — name the actual skills, not just a count
    if resume.skills_block:
        parts = re.split(r"[,|•\n/\-]+", resume.skills_block)
        skill_count = len([p for p in parts if p.strip()])
        sample = _sample_skills(resume.skills_block, n=4)
        sample_str = ", ".join(sample)
        if skill_count >= SKILLS_STRONG_THRESHOLD and sample_str:
            strengths.append(
                f"Strong, specific skills section — {skill_count} listed competencies "
                f"including {sample_str}, giving ATS parsers a clear technical profile."
            )
        elif skill_count >= SKILLS_ADEQUATE_THRESHOLD and sample_str:
            strengths.append(f"Skills section covers core competencies such as {sample_str}.")

    # High keyword match — name the actual terms shared with top-matching jobs
    matched_terms = _matched_job_terms(resume, top_jobs, n=5)
    if kw_score >= 70:
        if matched_terms:
            strengths.append(
                f"Vocabulary aligns with your top-matching job postings — terms like "
                f"{', '.join(matched_terms)} appear in both ({int(kw_score)}% keyword match)."
            )
        else:
            strengths.append(
                f"Resume vocabulary aligns well with job market keywords "
                f"({int(kw_score)}% keyword match) — good ATS discoverability."
            )

    # Quantified impact — quote the actual bullet(s) that contain metrics
    if impact_score >= 60:
        examples = _extract_impact_examples(
            "\n".join(filter(None, [resume.experience_block, resume.projects_block])),
            max_examples=2,
        )
        if examples:
            quoted = " / ".join(f"\"{e}\"" for e in examples)
            strengths.append(
                f"Uses quantified, achievement-oriented language — e.g. {quoted} — "
                "makes your impact concrete and easy to scan."
            )
        else:
            strengths.append(
                "Experience section uses quantified, achievement-oriented language "
                "(numbers, percentages, or metrics detected) — makes impact tangible."
            )

    # All key sections present
    if format_score >= 80:
        strengths.append(
            "Resume structure is complete — summary, experience, skills, and "
            "education sections all detected by the parser."
        )

    # Education present — reference the actual line
    if resume.education_block:
        edu_preview = _first_line(resume.education_block)
        if edu_preview:
            strengths.append(f"Education section is clearly structured, e.g. \"{edu_preview}\".")
        else:
            strengths.append("Education section is present and clearly structured.")

    # Projects bonus — reference the actual project
    if resume.projects_block:
        proj_preview = _first_line(resume.projects_block)
        if proj_preview:
            strengths.append(
                f"Projects section adds concrete proof of skills beyond job titles, "
                f"e.g. \"{proj_preview}\"."
            )
        else:
            strengths.append("Projects section adds concrete proof of skills beyond job titles.")

    # Certifications bonus — reference the actual certification
    if resume.certifications_block:
        cert_preview = _first_line(resume.certifications_block)
        if cert_preview:
            strengths.append(
                f"Certifications signal professional development commitment, "
                f"e.g. \"{cert_preview}\"."
            )
        else:
            strengths.append("Certifications section signals professional development commitment.")

    # Word count in good range
    if WORD_COUNT_IDEAL_LOW <= resume.word_count <= WORD_COUNT_IDEAL_HIGH:
        strengths.append(
            f"Resume length ({resume.word_count} words) is in the optimal "
            "450–700 word range for ATS parsing and human readability."
        )

    # Return up to 4 strongest, always at least 2
    if not strengths:
        strengths = [
            "Resume was successfully parsed — content is machine-readable.",
            "File format is compatible with standard ATS systems.",
        ]

    return strengths[:4]


# ─────────────────────────────────────────────────────────────────────────────
# IMPROVEMENT GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

def _generate_improvements(
    resume: ParsedResume,
    kw_score: float,
    skills_score: float,
    impact_score: float,
    format_score: float,
    length_score: float,
    top_jobs: Optional[list[dict]] = None,
) -> list[str]:
    improvements = []

    # Missing or thin sections
    if not resume.summary_block:
        improvements.append(
            "Add a 2–3 sentence professional summary at the top — "
            "ATS systems use it to classify your profile before reading further."
        )
    if not resume.skills_block:
        improvements.append(
            "Add a dedicated Skills section listing tools, languages, and frameworks — "
            "it's the highest-signal section for ATS keyword matching."
        )

    # Low impact score — point at an actual bullet lacking a metric
    if impact_score < 50:
        weak_bullet = _first_line(resume.experience_block)
        if weak_bullet:
            improvements.append(
                f"Add measurable results to bullets like \"{weak_bullet}\" — "
                "specify numbers, percentages, or scale (e.g., 'reduced load time by 40%', "
                "'led a team of 8') to make the accomplishment concrete."
            )
        else:
            improvements.append(
                "Add quantified achievements to your experience bullets "
                "(e.g., 'Reduced load time by 40%', 'Led team of 8') — "
                "numbers make accomplishments concrete and memorable."
            )

    # Low keyword score — name the actual missing terms from top-matching jobs
    if kw_score < 60:
        missing_terms = _missing_job_terms(resume, top_jobs, n=5)
        if missing_terms:
            improvements.append(
                f"Consider adding these terms if they apply to your experience: "
                f"{', '.join(missing_terms)} — they appear frequently in your top-matching "
                "job postings but not in your resume."
            )
        else:
            improvements.append(
                "Incorporate more industry-specific keywords from target job postings — "
                "mirror their exact phrasing where truthful to improve ATS match rate."
            )

    # Too short
    if resume.word_count < WORD_COUNT_MIN:
        improvements.append(
            f"Resume is short ({resume.word_count} words) — expand experience "
            "descriptions with specific accomplishments to reach the 450–700 word sweet spot."
        )
    # Too long
    elif resume.word_count > WORD_COUNT_MAX:
        improvements.append(
            f"Resume is long ({resume.word_count} words) — trim older or less relevant "
            "roles to keep it focused; aim for 450–700 words."
        )

    # No projects or certifications
    if not resume.projects_block and not resume.certifications_block:
        improvements.append(
            "Add a Projects or Certifications section to demonstrate applied "
            "skills beyond your job history."
        )

    # Low skills score
    if skills_score < 50:
        improvements.append(
            "Expand your Skills section — list specific tools, frameworks, "
            "and technologies relevant to your target role."
        )

    # Fallback
    if not improvements:
        improvements = [
            "Tailor your summary and skills section keywords to each specific job posting.",
            "Ensure consistent date formatting throughout experience entries.",
        ]

    return improvements[:4]


# ─────────────────────────────────────────────────────────────────────────────
# SKILL GAP DETECTOR — PRIMARY PATH (direct job-posting comparison)
# ─────────────────────────────────────────────────────────────────────────────

def _detect_skill_gaps_from_posting(
    resume: ParsedResume,
    job_posting_text: str,
    source_label: str,
    exclude_terms: Optional[set[str]] = None,
) -> list[dict]:
    """
    PRIMARY skill-gap path (new this revision): extracts skill/keyword
    terms directly from a real job posting (either the user's pasted JD,
    or the single best-matching real JSearch listing) and compares them
    straight against the resume — Matched vs Missing — exactly per the
    original spec:

        JOB POSTING: Python, FastAPI, PostgreSQL, Docker, AWS, ...
        RESUME:      Python, Flask, PostgreSQL, Git
        Matched:     Python, PostgreSQL
        Missing:     FastAPI, Docker, AWS, ...

    No taxonomy, no aggregation across multiple jobs, no static
    per-role checklist — this reads ONE real posting's actual text.

    Uses extract_skill_terms_from_posting() — a precision-oriented
    extractor built specifically for this use case (see its docstring in
    keyword_extractor.py for why it's a separate function from
    extract_keywords_from_text(), which stays a looser, recall-oriented
    extractor used only for building JSearch/Adzuna search queries).

    exclude_terms should be the job's own title + company name, tokenized
    by the caller (see analyze_controller._select_job_posting_text) —
    this stops company-name fragments (e.g. "Solutions" from "SIGINT
    Solutions, LLC") from ever being reported as a required skill.

    Falls back to _detect_skill_gaps() (the pre-existing
    taxonomy/aggregate approach) when job_posting_text is empty — see
    enrich_resume_local()'s branch below.
    """
    posting_terms = extract_skill_terms_from_posting(
        job_posting_text, top_n=20, exclude_terms=exclude_terms
    )
    if not posting_terms:
        return []

    resume_text = (resume.raw_text or "").lower()

    # Substring-first (unchanged), semantic fallback per term — this is
    # the highest-value spot for semantic matching in the whole file:
    # posting_terms come from a REAL job posting's actual wording, so
    # phrasing mismatches against the resume ("React.js" in the
    # posting vs "ReactJS" on the resume) are common and exactly what
    # substring matching alone misses. See skill_matcher.py.
    matches = skills_present(
        posting_terms,
        resume_text,
        skills_block=resume.skills_block,
        raw_text=resume.raw_text,
    )

    results: list[dict] = []
    for term in posting_terms:
        match = matches[term]
        present = match.present
        # Title-case short/lowercase tokens for display (e.g. "python" ->
        # "Python"); leave anything already mixed-case (e.g. "PostgreSQL",
        # "CI/CD") exactly as extracted, since forcing .title() on those
        # would mangle them (e.g. "Ci/Cd").
        display_skill = term.title() if term.islower() else term
        if present and match.matched_via == "semantic":
            found_note = f"Found in your resume as \u201c{match.matched_phrase}\u201d — matches {source_label}."
        elif present:
            found_note = f"Found in your resume — matches {source_label}."
        else:
            found_note = (
                f"Listed in {source_label} but not found in your resume — "
                "add it if it truthfully applies to your experience."
            )
        results.append({
            "skill": display_skill,
            "missing": not present,
            "recommendation": found_note,
        })

    # Matched skills first (what you already have), then gaps — mirrors
    # how the original Matched/Missing spec reads top-to-bottom.
    results.sort(key=lambda r: r["missing"])
    return results[:12]


def _detect_keyword_gaps_from_postings(
    resume: ParsedResume,
    postings: list[dict],
) -> list[dict]:
    """
    Optimization path: looks at the best posting for each of the user's top
    five companies and reports terms ranked by how many postings mention them.

    postings: [{"text": str, "label": "Title at Company", "company": str,
                "exclude_terms": set}]
    Returns {skill, missing, recommendation, source_companies} entries.
    """
    counts: dict[str, int] = {}
    display: dict[str, str] = {}
    companies_by_term: dict[str, list[str]] = {}
    for posting in postings:
        terms = extract_skill_terms_from_posting(
            posting["text"], top_n=20, exclude_terms=posting.get("exclude_terms")
        )
        for term in dict.fromkeys(terms):  # once per posting
            key = term.lower()
            counts[key] = counts.get(key, 0) + 1
            display.setdefault(key, term)
            company = posting.get("company")
            if company and company not in companies_by_term.setdefault(key, []):
                companies_by_term[key].append(company)

    if not counts:
        return []

    keys = sorted(counts, key=lambda k: (-counts[k], k))
    resume_text = (resume.raw_text or "").lower()
    matches = skills_present(
        [display[k] for k in keys],
        resume_text,
        skills_block=resume.skills_block,
        raw_text=resume.raw_text,
    )

    total = len(postings)
    results: list[dict] = []
    for k in keys:
        term = display[k]
        present = matches[term].present
        shown = term.title() if term.islower() else term
        where = f"{counts[k]} of {total} top-company postings"
        results.append({
            "skill": shown,
            "missing": not present,
            "source_companies": companies_by_term.get(k, []),
            "recommendation": (
                f"Found in your resume \u2014 also asked for in {where}."
                if present else
                f"Asked for in {where} but not found in your resume \u2014 "
                "add it if it truthfully applies to your experience."
            ),
        })

    results.sort(key=lambda r: r["missing"])
    return results[:12]


# ─────────────────────────────────────────────────────────────────────────────
# SKILL GAP DETECTOR — BACKUP/FALLBACK PATH (unchanged from before)
# ─────────────────────────────────────────────────────────────────────────────

def _detect_skill_gaps(
    resume: ParsedResume,
    top_jobs: list[dict],
    target_job_gap: Optional[dict] = None,
) -> list[dict]:
    """
    BACKUP path — used only when no job-posting text is available at all
    (no pasted JD and no matched job listing; see enrich_resume_local()).

    Cross-references the resume's skills_block against:
      0. The user's target_job checklist (target_job_matcher), if their
         target job title matched a known supported role — highest
         priority, since it's an explicit, curated requirement list for
         the exact role they said they want.
      1. The matched_skills from top jobs to surface role-specific gaps
      2. The SKILL_TAXONOMY to identify category-level gaps

    Returns a list of dicts matching the frontend SkillGap shape:
      { skill, missing (bool), recommendation }

    missing=False → skill IS present (shown green as "REQUIRED" met)
    missing=True  → skill is NOT present (shown orange as "OPTIONAL" / gap)
    """
    resume_text = (resume.raw_text or "").lower()
    skills_text = (resume.skills_block or "").lower()

    results: list[dict] = []
    seen: set[str] = set()

    # ── Step 0: target-job checklist (highest priority — explicit, role-specific) ──
    if target_job_gap:
        role = target_job_gap.get("target_job", "your target role")
        for skill in target_job_gap.get("matched_skills", []):
            key = skill.lower()
            if key in seen:
                continue
            seen.add(key)
            results.append({
                "skill": skill.title(),
                "missing": False,
                "recommendation": f"Required for {role} — already detected in your resume.",
            })
        for skill in target_job_gap.get("missing_required_skills", []):
            key = skill.lower()
            if key in seen:
                continue
            seen.add(key)
            results.append({
                "skill": skill.title(),
                "missing": True,
                "recommendation": f"Required for {role} — not detected in your resume yet.",
            })

    # ── Step 1: top job matched_skills (role-specific, from real listings) ──
    job_skill_counts: dict[str, int] = {}
    for job in top_jobs[:10]:
        for skill in job.get("matched_skills", []):
            s = skill.lower().strip()
            if s:
                job_skill_counts[s] = job_skill_counts.get(s, 0) + 1

    # Sort by frequency — most common across top jobs first
    top_job_skills = sorted(job_skill_counts, key=lambda s: job_skill_counts[s], reverse=True)

    # Substring-first (unchanged), semantic fallback per skill — a job's
    # matched_skills are drawn from real listings, so surface-form
    # mismatches against the resume are as likely here as in the
    # posting-based path above.
    top_job_skill_matches = skills_present(
        top_job_skills[:6],
        resume_text,
        skills_block=resume.skills_block,
        raw_text=resume.raw_text,
    )

    for skill in top_job_skills[:6]:
        if skill in seen:
            continue
        seen.add(skill)
        match = top_job_skill_matches[skill]
        present = match.present
        if present and match.matched_via == "semantic":
            note = f"Detected in your resume as \u201c{match.matched_phrase}\u201d."
        elif present:
            note = "Already detected in your resume."
        else:
            note = (
                f"Appears in {job_skill_counts[skill]} of your top job matches — "
                f"add it if applicable to your experience."
            )
        results.append({
            "skill": skill.title(),
            "missing": not present,
            "recommendation": note,
        })

    # ── Step 2: taxonomy categories to fill up to 6 items ──
    # Substring-first per category (unchanged: any literal term hit),
    # semantic fallback only for categories with no literal hit at all
    # — this is what lets e.g. a skills_block listing "React framework"
    # register under "Web Development" even though none of that
    # category's literal terms ("react", "vue", ...) appear verbatim.
    remaining_categories = [c for c in SKILL_TAXONOMY if c not in seen]
    remaining_terms = [t for c in remaining_categories for t in SKILL_TAXONOMY[c]]
    taxonomy_matches = skills_present(
        remaining_terms,
        resume_text,
        skills_block=resume.skills_block,
        raw_text=resume.raw_text,
    ) if remaining_terms else {}

    for category, terms in SKILL_TAXONOMY.items():
        if len(results) >= 6:
            break
        if category in seen:
            continue

        # Check if any term from this category appears in skills_block or resume
        present_in_skills = any(t in skills_text for t in terms)
        present_in_resume = any(t in resume_text for t in terms)
        present_in_resume_semantic = any(taxonomy_matches[t].present for t in terms)

        # Only surface gaps (not present at all) or strengths (in skills block)
        if present_in_skills:
            seen.add(category)
            results.append({
                "skill": category,
                "missing": False,
                "recommendation": f"Evident in your skills section — good coverage.",
            })
        elif present_in_resume_semantic and not present_in_resume:
            seen.add(category)
            results.append({
                "skill": category,
                "missing": False,
                "recommendation": "Evident in your resume, under different wording than the standard term.",
            })
        elif not present_in_resume:
            seen.add(category)
            results.append({
                "skill": category,
                "missing": True,
                "recommendation": (
                    f"Not detected in your resume — consider adding relevant "
                    f"{category.lower()} skills if applicable to your target role."
                ),
            })

    return results[:6]


# ─────────────────────────────────────────────────────────────────────────────
# FORMATTING & READABILITY CHECKER
# Two families of checks, both feeding the same "grammar_issues" output list
# (kept as-is for frontend/API compatibility):
#
#   1. VISUAL FLOW  — structural/visual consistency: bullet glyphs, date
#      formats, wall-of-text bullets. These affect how easily a human (and
#      some ATS parsers) can scan the document, independent of wording.
#   2. LINGUISTIC CLARITY — sentence-level wording: passive voice, tense,
#      filler, clichés, first-person pronouns, overlong sentences.
#
# Each issue carries a "type" so the frontend can group/label them; issues
# are deduped by type (max one of each) and capped at 6 total, ordered
# visual-flow first since structural issues are usually higher-impact and
# faster to fix than wording tweaks.
# ─────────────────────────────────────────────────────────────────────────────

MAX_FORMATTING_READABILITY_ISSUES = 8


def _bulleted_lines(block: Optional[str]) -> list[str]:
    """Returns lines within a block that open with a recognized bullet glyph."""
    if not block:
        return []
    return [line for line in block.split("\n") if _BULLET_LINE_RE.match(line)]


def _check_content_sufficiency(resume: ParsedResume) -> Optional[dict]:
    """
    Flags resumes too short for the other checks to meaningfully evaluate.
    Without this, a near-empty resume triggers none of the pattern-based
    checks below (nothing to mismatch) and silently falls through to a
    false-positive "no issues detected" result.
    """
    if resume.word_count < MIN_WORDS_FOR_READABILITY_CHECK:
        return {
            "type": "Content",
            "text": f"Resume has very little text ({resume.word_count} words) — "
                    "there isn't enough content here to reliably assess formatting and "
                    "readability. Add more detail to your experience section first.",
        }
    return None


def _check_bullet_consistency(resume: ParsedResume) -> Optional[dict]:
    """
    Flags mixed bullet glyphs (e.g. some lines use '•', others '-' or '*')
    within the same section. Inconsistent bullets are one of the most common
    "looks unpolished" signals recruiters and ATS renderers pick up on.
    """
    lines = _bulleted_lines(resume.experience_block) + _bulleted_lines(resume.projects_block)
    if len(lines) < 3:
        return None  # not enough bulleted content to judge consistency

    glyphs_used: set[str] = set()
    for line in lines:
        m = _BULLET_LINE_RE.match(line)

        if m is None:
            continue

        glyphs_used.add(m.group(1)[0])  # first char of the matched bullet token

    if len(glyphs_used) > 1:
        example = ", ".join(sorted(glyphs_used)[:3])
        return {
            "type": "Formatting",
            "text": f"Bullet style is inconsistent across sections (mixing '{example}') — "
                    "pick one bullet glyph and use it throughout for a cleaner, more scannable layout.",
        }
    return None


def _check_date_format_consistency(resume: ParsedResume) -> Optional[dict]:
    """
    Flags mixed date formats (e.g. 'Jan 2020' alongside '01/2020') anywhere
    in the resume. Inconsistent dates disrupt visual scanning and can also
    confuse ATS date-range parsing.
    """
    text = resume.raw_text or ""
    families_found = [name for name, pattern in _DATE_FORMATS.items() if pattern.search(text)]
    if len(families_found) > 1:
        return {
            "type": "Consistency",
            "text": "Date formatting is inconsistent (mixing styles like "
                    f"{' and '.join(families_found[:2])}) — standardize on one format throughout.",
        }
    return None


def _check_wall_of_text(resume: ParsedResume) -> Optional[dict]:
    """
    Flags an experience section that reads as dense paragraphs rather than
    scannable bullets — either no bullet glyphs at all, or individual
    lines/bullets that run long without a break.
    """
    block = resume.experience_block
    if not block or len(block.strip()) < 80:
        return None

    bulleted = _bulleted_lines(block)
    lines = [l for l in block.split("\n") if l.strip()]

    if not bulleted and len(lines) <= 2:
        return {
            "type": "Readability",
            "text": "Experience section reads as a dense paragraph rather than bullet points — "
                    "break accomplishments into short bullets so recruiters can scan them in seconds.",
        }

    longest = max((len(l) for l in lines), default=0)
    if longest > MAX_READABLE_LINE_CHARS:
        return {
            "type": "Readability",
            "text": "Some experience lines run very long without a break — "
                    "split dense bullets into two shorter ones focused on a single accomplishment each.",
        }
    return None


def _check_sentence_length(resume: ParsedResume) -> Optional[dict]:
    """
    Flags overly long sentences (35+ words) in the summary/experience text,
    which hurt both human readability and ATS keyword-proximity parsing.
    """
    text = " ".join(filter(None, [resume.summary_block, resume.experience_block]))
    if not text:
        return None

    for sentence in re.split(r"[.!?\n]+", text):
        words = sentence.split()
        if len(words) > MAX_READABLE_SENTENCE_WORDS:
            preview = " ".join(words[:12]) + "…"
            return {
                "type": "Sentence Length",
                "text": f"Found an overly long sentence (\"{preview}\") — "
                        "break long sentences into two shorter ones for easier scanning.",
            }
    return None


def _check_contact_info(resume: ParsedResume) -> Optional[dict]:
    """
    Flags missing email, phone, or LinkedIn/portfolio URL. Contact info can
    parse fine as *text* (so resume_parser.py's "looks like a resume" gate
    passes) while still being incomplete for a human recruiter or an ATS's
    contact-routing fields — e.g. an email present but no phone, or no
    LinkedIn/portfolio link at all.
    """
    text = resume.raw_text or ""
    missing = []
    if not _EMAIL_RE.search(text):
        missing.append("email address")
    if not _PHONE_RE.search(text):
        missing.append("phone number")
    if not (_LINKEDIN_RE.search(text) or _URL_RE.search(text)):
        missing.append("LinkedIn or portfolio URL")

    if missing:
        return {
            "type": "Contact",
            "text": f"Missing {', '.join(missing)} — recruiters and ATS systems "
                    "both rely on complete, correctly formatted contact details "
                    "to route or reach out about your application.",
        }
    return None


def _check_section_order(resume: ParsedResume) -> Optional[dict]:
    """
    Flags a section order that deviates from the ATS-friendly convention
    (Summary -> Experience -> Education -> Skills). Detected via the
    earliest position of each section's representative keywords in
    raw_text, since ParsedResume only exposes extracted blocks, not the
    parser's original header order.
    """
    text = (resume.raw_text or "").lower()
    positions: list[tuple[int, str]] = []
    for section, kws in _SECTION_ORDER_KEYWORDS.items():
        best = None
        for kw in kws:
            idx = text.find(kw)
            if idx != -1 and (best is None or idx < best):
                best = idx
        if best is not None:
            positions.append((best, section))

    if len(positions) < 3:
        return None  # not enough detected sections to judge order meaningfully

    positions.sort()
    found_order = [s for _, s in positions]
    ideal_relevant = [s for s in _IDEAL_SECTION_ORDER if s in found_order]

    if found_order != ideal_relevant:
        pretty = " → ".join(s.title() for s in found_order)
        return {
            "type": "Section Order",
            "text": f"Section order ({pretty}) doesn't follow the ATS-friendly "
                    "convention (Summary → Experience → Education → Skills) — "
                    "reordering helps both parsers and human reviewers scan faster.",
        }
    return None


def _split_experience_roles(experience_block: Optional[str]) -> list[dict]:
    """
    Splits experience_block into individual role entries using a lightweight
    heuristic: consecutive non-bullet lines (job title, company, dates)
    accumulate into a role's header; the bullet lines that follow become
    that role's content. A new non-bullet line after bullets have already
    started signals the start of the next role.

    Returns a list of {"header": str, "bullets": list[str]} dicts — only
    for roles that actually have bullet content, since role-level checks
    below need bullets to evaluate.
    """
    if not experience_block:
        return []

    lines = [l for l in experience_block.split("\n") if l.strip()]
    roles: list[dict] = []
    header_parts: list[str] = []
    current: Optional[dict] = None

    for line in lines:
        if _BULLET_LINE_RE.match(line):
            if current is None:
                current = {"header": " — ".join(header_parts) or "Unlabeled role", "bullets": []}
                roles.append(current)
                header_parts = []
            current["bullets"].append(line.strip())
        else:
            if current is not None and current["bullets"]:
                current = None  # previous role's bullets are done; this starts a new one
            header_parts.append(line.strip())

    return [r for r in roles if r["bullets"]]


def _bullet_first_word(line: str) -> str:
    """Strips a bullet line's glyph/number prefix and returns its first word."""
    text = re.sub(r"^\s*([•◦▪‣●\-*–—]|\d{1,2}[.)])\s+", "", line).strip()
    words = text.split()
    return words[0] if words else ""


def _check_bullet_count_per_role(resume: ParsedResume) -> Optional[dict]:
    """
    Flags a role with too few bullets (<2, looks thin/unfinished) or too
    many (>8, unfocused — the strongest accomplishments get buried).
    """
    roles = _split_experience_roles(resume.experience_block)
    for role in roles:
        n = len(role["bullets"])
        label = role["header"] or "one of your roles"
        if len(label) > 70:
            label = label[:67].rstrip() + "..."
        if n < MIN_BULLETS_PER_ROLE:
            return {
                "type": "Bullet Count",
                "text": f"\"{label}\" has only {n} bullet point(s) — roles with fewer than "
                        f"{MIN_BULLETS_PER_ROLE} bullets look thin; add more detail or "
                        "consider merging it with a related entry.",
            }
        if n > MAX_BULLETS_PER_ROLE:
            return {
                "type": "Bullet Count",
                "text": f"\"{label}\" has {n} bullet points — that's a lot for one role; "
                        f"trim to your {MAX_BULLETS_PER_ROLE} strongest accomplishments so they "
                        "don't get buried.",
            }
    return None


def _check_achievement_task_ratio(resume: ParsedResume) -> Optional[dict]:
    """
    Flags a role where every bullet describes a duty ("managed X",
    "responsible for Y") with zero quantified outcomes — a lower bar than
    the whole-resume _score_impact dimension, catching a single weak role
    even when other roles pull the overall impact score up.
    """
    roles = _split_experience_roles(resume.experience_block)
    for role in roles:
        bullets = role["bullets"]
        if len(bullets) < 3:
            continue  # too few bullets for the ratio to mean much
        has_achievement = any(
            any(re.search(p, b, re.IGNORECASE) for p in IMPACT_PATTERNS)
            for b in bullets
        )
        if not has_achievement:
            label = role["header"] or "one of your roles"
            if len(label) > 70:
                label = label[:67].rstrip() + "..."
            return {
                "type": "Impact",
                "text": f"All {len(bullets)} bullets under \"{label}\" describe duties with no "
                        "measurable outcome — rewrite one or two as results (numbers, %, scale) "
                        "so the role shows impact, not just tasks.",
            }
    return None


def _check_tense_consistency_per_role(resume: ParsedResume) -> Optional[dict]:
    """
    Flags a role whose bullets mix past-tense and present-tense opening
    verbs (e.g. "Led the migration" next to "Manage the team"). Different
    from the resume-wide GRAMMAR_CHECKS tense pattern, which only catches
    the "is/are + -ing" construction — this checks internal consistency
    within one job entry using a small paired present/past verb list.
    """
    roles = _split_experience_roles(resume.experience_block)
    for role in roles:
        bullets = role["bullets"]
        if len(bullets) < 2:
            continue
        tenses_found: set[str] = set()
        for b in bullets:
            word = _bullet_first_word(b).lower().strip(".,;:")
            if word in _PAST_TENSE_VERBS:
                tenses_found.add("past")
            elif word in _PRESENT_TENSE_VERBS:
                tenses_found.add("present")
        if len(tenses_found) > 1:
            label = role["header"] or "one of your roles"
            if len(label) > 70:
                label = label[:67].rstrip() + "..."
            return {
                "type": "Tense Consistency",
                "text": f"Bullets under \"{label}\" mix past and present tense verbs — "
                        "use present tense for your current role and past tense for "
                        "previous roles, consistently within each entry.",
            }
    return None


def _check_verb_repetition(resume: ParsedResume) -> Optional[dict]:
    """
    Flags an opening action verb reused across many bullets (e.g. "Managed"
    starting 5+ bullets). Repeated openers make bullets blur together even
    when the underlying accomplishments differ.
    """
    lines = _bulleted_lines(resume.experience_block) + _bulleted_lines(resume.projects_block)
    if len(lines) < 4:
        return None

    counts: dict[str, int] = {}
    for line in lines:
        word = re.sub(r"[^a-z]", "", _bullet_first_word(line).lower())
        if len(word) < 3:
            continue
        counts[word] = counts.get(word, 0) + 1

    if not counts:
        return None

    verb, count = max(counts.items(), key=lambda kv: kv[1])
    if count >= VERB_REPETITION_THRESHOLD:
        return {
            "type": "Variety",
            "text": f"The verb \"{verb.title()}\" opens {count} of your bullets — repeating "
                    "the same starting verb makes accomplishments blur together; vary it with "
                    "other strong verbs (built, drove, launched, streamlined) that fit each one.",
        }
    return None


_spell_checker_instance = None


def _get_spell_checker():
    global _spell_checker_instance
    if _spell_checker_instance is None and _SpellChecker is not None:
        _spell_checker_instance = _SpellChecker(distance=1)
    return _spell_checker_instance


def _check_spelling(resume: ParsedResume) -> Optional[dict]:
    """
    Real dictionary-based spellcheck (via pyspellchecker) over the
    summary/experience/education text — everything else in this module is
    pattern-based, so a genuine misspelling never gets caught anywhere
    else. Skips the check entirely if pyspellchecker isn't installed,
    rather than failing the whole enrichment pipeline.

    False-positive reduction:
      - skills_block terms are excluded (technical/product names)
      - words containing any uppercase letter after the first character
        are excluded (brand names, camelCase like "JavaScript")
      - fully-uppercase words are excluded (acronyms)
      - a small SPELLING_WHITELIST covers common tech/resume vocabulary
        that a general-English dictionary doesn't recognize
      - words under 4 letters are excluded (dictionary coverage for very
        short tokens is unreliable and produces noisy false positives)
    """
    spell = _get_spell_checker()
    if spell is None:
        return None

    text = " ".join(filter(None, [
        resume.summary_block, resume.experience_block, resume.education_block,
    ]))
    if len(text.split()) < 40:
        return None  # not enough content for a meaningful spellcheck pass

    skills_text = (resume.skills_block or "").lower()
    words = re.findall(r"[A-Za-z]+", text)

    candidates: list[str] = []
    for w in words:
        if len(w) < 4 or not w.islower():
            continue
        if w in skills_text or w in SPELLING_WHITELIST:
            continue
        candidates.append(w)

    if not candidates:
        return None

    unknown = spell.unknown(candidates)
    unknown = {w for w in unknown if w not in SPELLING_WHITELIST}
    if not unknown:
        return None

    examples: list[str] = []
    seen: set[str] = set()
    for w in candidates:
        if w in unknown and w not in seen:
            seen.add(w)
            examples.append(w)
        if len(examples) >= 3:
            break

    return {
        "type": "Spelling",
        "text": f"Possible spelling issue(s) detected: {', '.join(examples)} — "
                "double-check these against a dictionary; typos are one of the "
                "most damaging things a resume can have with both recruiters and ATS parsers.",
    }


def _check_grammar(resume: ParsedResume) -> list[dict]:
    """
    Runs the full Formatting & Readability check set:
      1. Content gate: is there enough text to evaluate at all.
      2. Contact & structure: contact info completeness, section order.
      3. Visual flow: bullet consistency, date-format consistency, wall-of-text.
      4. Per-role structure: bullet count, achievement/task ratio, tense consistency.
      5. Word-choice: verb repetition, real spelling errors.
      6. Linguistic clarity: overlong sentences, plus the pattern-based
         GRAMMAR_CHECKS (passive voice, tense, filler, clichés, pronouns).

    Returns up to MAX_FORMATTING_READABILITY_ISSUES issues, deduped by type,
    ordered roughly by impact/fix-speed (structural and factual issues —
    missing contact info, real typos — surface before wording nitpicks).
    """
    issues: list[dict] = []
    seen_types: set[str] = set()

    def _add(issue: Optional[dict]) -> None:
        if issue and issue["type"] not in seen_types:
            issues.append(issue)
            seen_types.add(issue["type"])

    # ── 0. Content sufficiency gate ────────────────────────────────────────
    _add(_check_content_sufficiency(resume))

    # ── 1. Contact & document structure ────────────────────────────────────
    _add(_check_contact_info(resume))
    _add(_check_section_order(resume))

    # ── 2. Visual flow checks (structural/visual consistency) ─────────────
    _add(_check_bullet_consistency(resume))
    _add(_check_date_format_consistency(resume))
    _add(_check_wall_of_text(resume))

    # ── 3. Per-role structure checks ───────────────────────────────────────
    _add(_check_bullet_count_per_role(resume))
    _add(_check_achievement_task_ratio(resume))
    _add(_check_tense_consistency_per_role(resume))

    # ── 4. Word-choice checks ──────────────────────────────────────────────
    _add(_check_verb_repetition(resume))
    _add(_check_spelling(resume))

    # ── 5. Linguistic clarity checks (sentence-level wording) ─────────────
    _add(_check_sentence_length(resume))

    text = (resume.raw_text or "").lower()
    for check in GRAMMAR_CHECKS:
        if len(issues) >= MAX_FORMATTING_READABILITY_ISSUES:
            break
        if check["type"] in seen_types:
            continue
        if re.search(check["pattern"], text, re.IGNORECASE):
            _add({"type": check["type"], "text": check["text"]})

    # If no issues found across any category, return a positive note
    if not issues:
        issues = [{
            "type": "Style",
            "text": "No major formatting or readability issues detected — "
                    "resume is visually consistent and reads clearly.",
        }]

    return issues[:MAX_FORMATTING_READABILITY_ISSUES]


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API — drop-in replacement for _enrich_with_ai()
# ─────────────────────────────────────────────────────────────────────────────

def enrich_resume_local(
    resume: ParsedResume,
    keywords: list[str],
    top_jobs: list[dict],
    target_job_gap: Optional[dict] = None,
    job_posting_text: Optional[str] = None,
    job_posting_source: Optional[str] = None,
    job_posting_exclude_terms: Optional[set[str]] = None,
    keyword_postings: Optional[list[dict]] = None,
) -> dict:
    """
    PUBLIC ENTRY POINT for this file — this is the only function other
    modules need to call; everything above it is internal implementation
    detail feeding into this function.

    Computes all dashboard enrichment data locally from the ParsedResume.
    Returns a dict with the exact same shape as the old Claude JSON response,
    so main.py needs zero changes to the return block.

    Args:
        resume:    ParsedResume object from resume_parser.parse_resume()
        keywords:  list of extracted keyword strings from keyword_extractor
        top_jobs:  list of shaped job dicts (already scored by job_scorer)
        target_job_gap: optional dict from
            target_job_matcher.calculate_target_job_gap(target_job, resume)
            — None if the user left target_job blank or it didn't match a
            supported role. Only used by the BACKUP skill-gap path below.
        job_posting_text: optional real job-posting text — the full
            description of the single best-matching real job listing
            from JSearch. When present, this becomes the PRIMARY source
            for skill_gaps (see _detect_skill_gaps_from_posting): a
            direct Matched/Missing comparison against this actual
            posting, no taxonomy involved.
        job_posting_source: human-readable label describing where
            job_posting_text came from (e.g. "your top-matching job
            posting (Backend Engineer at Acme)") — used in skill_gaps
            recommendations and
            echoed back in the result as skill_gap_source, so the caller
            can be transparent with the user about which mode produced
            these results.
        job_posting_exclude_terms: tokenized words from the matched
            job's own title + company name (e.g. {"network", "engineer",
            "athenix", "cyber", "sigint", "solutions", "llc"}). Passed
            through to extract_skill_terms_from_posting() so the job's
            own metadata is never mistaken for one of its required
            skills. Safe to omit — defaults to no exclusions.

    Returns:
        {
            ats_score:      int 0–100,
            sections:       [{ name, value }] × 5,
            strengths:      [str] × 3–4,
            improvements:   [str] × 3–4,
            skill_gaps:     [{ skill, missing, recommendation }] × ≤12,
            grammar_issues: [{ type, text }] × ≤MAX_FORMATTING_READABILITY_ISSUES (8),
            skill_gap_source: str — which path/source produced skill_gaps.
        }
    """
    # ── Compute dimension scores ──────────────────────────────────────────────
    kw_score     = _score_keywords(resume, keywords, top_jobs)
    format_score = _score_format(resume)
    skills_score = _score_skills(resume)
    impact_score = _score_impact(resume)
    length_score = _score_length(resume)

    # ── ATS Score: weighted average ───────────────────────────────────────────
    ats_score = round(
        kw_score     * 0.25 +
        format_score * 0.20 +
        skills_score * 0.25 +
        impact_score * 0.20 +
        length_score * 0.10
    )
    # Clamp to valid range
    ats_score = max(0, min(100, ats_score))

    # ── Skill gaps: PRIMARY (direct job-posting comparison) with BACKUP
    #    fallback to the existing taxonomy/aggregate approach ────────────────
    if job_posting_text and job_posting_text.strip():
        skill_gaps = _detect_skill_gaps_from_posting(
            resume,
            job_posting_text,
            job_posting_source or "the job posting",
            exclude_terms=job_posting_exclude_terms,
        )
        skill_gap_source = job_posting_source or "job posting"
        # A posting that yields zero extractable terms (e.g. very short/odd
        # text) shouldn't silently produce an empty skill_gaps list — fall
        # back to the backup path rather than showing nothing.
        if not skill_gaps:
            skill_gaps = _detect_skill_gaps(resume, top_jobs, target_job_gap=target_job_gap)
            skill_gap_source = (
                "fallback hardcoded taxonomy (job_requirements.py / SKILL_TAXONOMY) — "
                "the matched job listing's text didn't yield any extractable skill terms"
            )
    else:
        skill_gaps = _detect_skill_gaps(resume, top_jobs, target_job_gap=target_job_gap)
        skill_gap_source = (
            "fallback hardcoded taxonomy (job_requirements.py / SKILL_TAXONOMY) — "
            "no job listing was matched by JSearch"
        )

    # ── Keyword gaps: top-3-company postings (skills above stay top-1) ──────
    keyword_gaps = (
        _detect_keyword_gaps_from_postings(resume, keyword_postings)
        if keyword_postings else []
    )
    keyword_gap_source = (
        "the best job posting from each of your top "
        f"{len(keyword_postings)} matched companies"
        if keyword_postings else ""
    )

    # ── Build output ─────────────────────────────────────────────────────────
    return {
        "ats_score": ats_score,
        "sections": [
            {"name": "Keywords", "value": int(kw_score)},
            {"name": "Format",   "value": int(format_score)},
            {"name": "Skills",   "value": int(skills_score)},
            {"name": "Impact",   "value": int(impact_score)},
            {"name": "Length",   "value": int(length_score)},
        ],
        "strengths":      _generate_strengths(
            resume, keywords, kw_score, skills_score, impact_score, format_score, top_jobs
        ),
        "improvements":   _generate_improvements(
            resume, kw_score, skills_score, impact_score, format_score, length_score, top_jobs
        ),
        "skill_gaps":       skill_gaps,
        "skill_gap_source": skill_gap_source,
        "keyword_gaps":       keyword_gaps,
        "keyword_gap_source": keyword_gap_source,
        "grammar_issues": _check_grammar(resume),
    }