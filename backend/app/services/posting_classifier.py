# app/services/posting_classifier.py
"""
Reads the three filter values straight off a JSearch job posting:

    job_type          -> one of JOB_TYPES
    experience_level  -> one of EXPERIENCE_LEVELS
    target_job        -> one of the 20 roles in JOB_REQUIREMENTS

Each classifier returns None when the posting gives no usable signal, so a
"not stated" posting never gets a guessed label (and therefore never shows up
under a filter it doesn't belong to).

What JSearch actually provides, and what we have to infer:
  - job type:   `job_employment_type(s)` (FULLTIME / PARTTIME / CONTRACTOR /
                INTERN). There is no "freelance" value - Google for Jobs files
                those under CONTRACTOR - so Freelance comes from the text.
  - experience: `job_required_experience` (months), but employers leave it
                empty on a large share of listings, so we fall back to the
                title, then to "N years of experience" in the posting text.
  - target job: JSearch has no such field, so it is matched from the job title
                against the 20 roles (and their aliases) in job_requirements.py.
"""

import re
from typing import List, Optional

from app.data.job_requirements import JOB_REQUIREMENTS, JOB_TITLE_ALIASES

# Exact strings the frontend filters use - keep these in sync with
# CompanyMatchCarousel.tsx.
JOB_TYPES: List[str] = ["Full-time", "Part-time", "Contractual", "Freelance", "Internship"]
EXPERIENCE_LEVELS: List[str] = ["Entry-Level", "Junior Level", "Mid-Level", "Senior"]
TARGET_JOBS: List[str] = list(JOB_REQUIREMENTS.keys())  # the 20 supported roles


def _norm(text: str) -> str:
    """Lowercase, '&' -> 'and', every other symbol -> space ('UI/UX' -> 'ui ux')."""
    text = (text or "").lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9+#]+", " ", text).strip()


def _posting_text(raw: dict) -> str:
    """Qualifications first (that's where the experience requirement usually
    lives), then the full description."""
    highlights = raw.get("job_highlights")
    quals = ""
    if isinstance(highlights, dict):
        q = highlights.get("Qualifications")
        if isinstance(q, list):
            quals = " ".join(str(x) for x in q)
    return f"{quals} {raw.get('job_description') or ''}"


# ─────────────────────────────────────────────────────────────
# JOB TYPE
# ─────────────────────────────────────────────────────────────
_ENUM_TO_TYPE = {
    "FULLTIME": "Full-time",
    "PARTTIME": "Part-time",
    "CONTRACTOR": "Contractual",
    "CONTRACT": "Contractual",
    "CONTRACTUAL": "Contractual",
    "INTERN": "Internship",
    "INTERNSHIP": "Internship",
}

_FREELANCE_RE = re.compile(r"\bfree[\s-]?lanc(?:e|er|ers|ing)\b", re.I)
# "Intern", "Interns", "Internship" as whole words only - never "internal" or
# "international". Titles only: descriptions mention interns in passing too often.
_INTERN_TITLE_RE = re.compile(r"\bintern(?:ship)?s?\b", re.I)
# In a TITLE a bare "contract" is a reliable signal ("smart contract" is not).
_CONTRACT_TITLE_RE = re.compile(r"(?<!smart )\bcontract(?:ual|or)?\b", re.I)
# In free text only the unambiguous phrasings count.
_CONTRACT_TEXT_RE = re.compile(
    r"\b(?:contractual|contract[\s-]based|contract[\s-]to[\s-]hire|fixed[\s-]term|"
    r"project[\s-]based|contract (?:basis|position|role|employment))\b",
    re.I,
)
_PART_TIME_RE = re.compile(r"\bpart[\s-]?time\b", re.I)
_FULL_TIME_RE = re.compile(r"\bfull[\s-]?time\b", re.I)


def _job_type_from_text(text: str, contract_re: "re.Pattern") -> Optional[str]:
    if _FREELANCE_RE.search(text):
        return "Freelance"
    if contract_re.search(text):
        return "Contractual"
    if _PART_TIME_RE.search(text):
        return "Part-time"
    if _FULL_TIME_RE.search(text):
        return "Full-time"
    return None


def classify_job_type(raw: dict, title: str) -> Optional[str]:
    enum_values = []
    if raw.get("job_employment_type"):
        enum_values.append(raw["job_employment_type"])
    if isinstance(raw.get("job_employment_types"), list):
        enum_values.extend(raw["job_employment_types"])

    mapped = None
    for v in enum_values:
        mapped = _ENUM_TO_TYPE.get(re.sub(r"[^A-Z]", "", str(v).upper()))
        if mapped:
            break

    description = raw.get("job_description") or ""

    # "Freelance" in the title is explicit, whatever the structured field says.
    if _FREELANCE_RE.search(title):
        return "Freelance"

    # "... Intern" / "Internship ..." in the title is explicit too.
    if _INTERN_TITLE_RE.search(title):
        return "Internship"

    if mapped:
        # JSearch has no freelance value; those postings arrive as CONTRACTOR.
        if mapped == "Contractual" and _FREELANCE_RE.search(description[:2000]):
            return "Freelance"
        return mapped

    # No structured value: title first, then the description.
    return (
        _job_type_from_text(title, _CONTRACT_TITLE_RE)
        or _job_type_from_text(description, _CONTRACT_TEXT_RE)
    )


# ─────────────────────────────────────────────────────────────
# EXPERIENCE LEVEL
# ─────────────────────────────────────────────────────────────
# Seniority words in the title are the clearest signal, so they win.
_STRONG_TITLE_HINTS = [
    ("Entry-Level", re.compile(r"\b(?:intern|internship|trainee|fresh graduates?|fresher|entry[\s-]?level)\b", re.I)),
    ("Junior Level", re.compile(r"\b(?:junior|associate)\b|\bjr(?:\.|\b)", re.I)),
    ("Mid-Level", re.compile(r"\b(?:mid[\s-]?level|intermediate)\b", re.I)),
    ("Senior", re.compile(r"\b(?:senior|lead|principal|staff|head of)\b|\bsr(?:\.|\b)", re.I)),
]
# Weaker: only used if nothing else produced an answer.
_WEAK_SENIOR_TITLE_RE = re.compile(r"\b(?:manager|director|architect|chief|vp)\b", re.I)

_YEARS_RE = re.compile(
    r"(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?)\b", re.I
)
_ENTRY_PHRASE_RE = re.compile(
    r"\b(?:no experience (?:is )?(?:required|needed|necessary)|fresh graduates?\b.{0,20}\bwelcome|entry[\s-]?level)\b",
    re.I,
)


def _level_from_months(months) -> Optional[str]:
    if not isinstance(months, (int, float)):
        return None
    # < 1 year -> Entry, 1-2 years -> Junior, 3-4 years -> Mid, 5+ years -> Senior
    if months < 12:
        return "Entry-Level"
    if months < 36:
        return "Junior Level"
    if months < 60:
        return "Mid-Level"
    return "Senior"


def _level_from_years_in_text(text: str) -> Optional[str]:
    """First 'N years ... experience' in the posting; for a range ('3-5 years')
    the lower bound is the stated requirement."""
    for m in _YEARS_RE.finditer(text):
        window = text[max(0, m.start() - 80): m.end() + 80].lower()
        if "experience" in window or "exp." in window:
            return _level_from_months(int(m.group(1)) * 12)
    return None


def classify_experience_level(raw: dict, title: str) -> Optional[str]:
    for level, pattern in _STRONG_TITLE_HINTS:
        if pattern.search(title):
            return level

    req = raw.get("job_required_experience")
    if isinstance(req, dict):
        if req.get("no_experience_required"):
            return "Entry-Level"
        level = _level_from_months(req.get("required_experience_in_months"))
        if level:
            return level

    text = _posting_text(raw)
    level = _level_from_years_in_text(text)
    if level:
        return level
    if _ENTRY_PHRASE_RE.search(text):
        return "Entry-Level"

    if _WEAK_SENIOR_TITLE_RE.search(title):
        return "Senior"
    return None


# ─────────────────────────────────────────────────────────────
# TARGET JOB (one of the 20 roles in JOB_REQUIREMENTS)
# ─────────────────────────────────────────────────────────────
# Extra title spellings per role, on top of the role's own name and
# JOB_TITLE_ALIASES from job_requirements.py. Add to these freely - a posting
# whose title contains an alias is labelled with that role.
_EXTRA_ALIASES = {
    "Fullstack Developer": ["fullstack developer", "full stack developer", "fullstack engineer",
                            "full stack engineer", "full stack web developer", "mern stack developer"],
    "Backend Developer": ["back end engineer", "api developer"],
    "Frontend Developer": ["react developer", "ui developer", "front end web developer"],
    "Mobile App Developer": ["mobile developer", "mobile application developer", "android developer",
                             "ios developer", "flutter developer", "react native developer",
                             "mobile engineer", "android engineer", "ios engineer"],
    "QA Engineer": ["quality assurance engineer", "qa tester", "software tester", "test engineer",
                    "qa analyst", "quality assurance analyst", "qa automation engineer", "sdet",
                    "quality assurance tester", "quality assurance specialist"],
    "Cloud Security Architect": ["cloud security engineer"],
    "SOC Analyst": ["security operations center analyst", "security operations analyst",
                    "security analyst", "threat detection analyst"],
    "Cloud Solutions Architect": ["cloud solution architect", "cloud architect", "solutions architect"],
    "DevOps / Platform Engineer": ["devops engineer", "platform engineer", "site reliability engineer",
                                   "sre", "devops specialist", "devops"],
    "Network Engineer": ["network administrator", "network specialist"],
    "IT Infrastructure Automation Engineer": ["infrastructure automation engineer", "infrastructure engineer",
                                              "it infrastructure engineer"],
    "Data Engineer": ["big data engineer", "etl developer", "analytics engineer"],
    "Data Analyst": ["business intelligence analyst", "bi analyst", "reporting analyst", "data analytics analyst"],
    "Database Administrator": ["dba", "database engineer"],
    "AI / Machine Learning Engineer": ["machine learning engineer", "ml engineer", "ai engineer",
                                       "artificial intelligence engineer", "ai ml engineer",
                                       "deep learning engineer", "machine learning developer", "ai developer"],
    "AI Solutions Architect": ["ai solution architect", "ai architect", "machine learning architect",
                               "ml architect"],
    "AI Governance & Risk Specialist": ["ai governance specialist", "ai risk specialist",
                                        "ai governance analyst", "ai compliance specialist",
                                        "responsible ai specialist", "ai risk and governance specialist"],
    "UI/UX Designer": [],
    "IT Support / Systems Administrator": ["it support specialist", "it support technician", "it support",
                                           "systems administrator", "system administrator", "sysadmin",
                                           "help desk technician", "desktop support"],
}


def _build_alias_index():
    index = {}
    for role in JOB_REQUIREMENTS:
        names = {role}
        names.update(JOB_TITLE_ALIASES.get(role.lower(), []))
        names.update(_EXTRA_ALIASES.get(role, []))
        for name in names:
            index[_norm(name)] = role
    # Longest (most specific) alias first: "cloud security engineer" must be
    # tried before "security engineer".
    return sorted(index.items(), key=lambda kv: (-len(kv[0].split()), -len(kv[0])))


_ALIAS_INDEX = _build_alias_index()


def classify_target_job(title: str) -> Optional[str]:
    padded = f" {_norm(title)} "
    for alias, role in _ALIAS_INDEX:
        if f" {alias} " in padded:
            return role
    return None