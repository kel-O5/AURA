# ==============================================================================
# FILE: app/services/keyword_extractor.py
# ==============================================================================
# PURPOSE OF THIS FILE (GUIDE):
#   This file turns a parsed resume (`ParsedResume`, produced by
#   resume_parser.py) into a short, ranked list of search-friendly keywords.
#   Those keywords are what get fed into jsearch_client.py to actually go
#   fetch matching real-world job listings — so the quality of this file's
#   output directly determines how relevant the job matches feel.
#
#   Pipeline position:
#       resume_parser.py  -->  keyword_extractor.py (THIS FILE)  -->  jsearch_client.py  -->  resume_enricher.py
#       (raw resume text      (turn resume into                    (fetch real job          (score resume vs.
#        -> structured           ranked keywords)                    listings)                those jobs)
#        sections)
#
# WHY MOSTLY NO EXTERNAL AI/ML LIBRARY:
#   Everything here is still primarily deterministic, local, and
#   dependency-light (plain `re` + `math` + `collections.Counter` — no
#   NLTK, no spaCy, no live API calls). This keeps keyword extraction fast,
#   free, and mostly offline-capable.
#
#   ONE exception, added deliberately: `extract_skill_terms_from_posting()`
#   (the user-facing "required skills for this role" extractor) now has an
#   optional semantic-similarity tier on top of the rule-based ones, via
#   `app/services/embedding_service.py` (a local BERT-family embedding
#   model, no external API call). It's additive and fails soft — see the
#   "Tier 1.5" section inside that function and the module docstring of
#   embedding_service.py for the full rationale. Every OTHER function in
#   this file is unchanged and remains pure rule-based.
#
# STRATEGY (see also the module docstring below):
#   1. Explicit skills listed in the resume's "Skills" section are the
#      highest-signal keywords — used first, as-is.
#   2. A lightweight single-document TF-IDF approximation surfaces other
#      important domain terms from the experience/summary/certifications
#      text (and falls back to the full raw text if that's too thin).
#   3. Known-skill vocabulary, tech-shaped tokens, certifications, acronyms
#      and repeated phrases are mined from the WHOLE resume (incl. projects)
#      to widen recall. Everything is alias-deduplicated and capped at
#      `top_n` (default 40; only the first few are sent to JSearch).
# ==============================================================================

# app/services/keyword_extractor.py
"""
Extracts ranked keywords from a parsed resume.

Strategy (no external AI needed at this phase):
  1. Take skills_block directly — highest signal
  2. Run TF-IDF over the full raw_text to surface domain keywords
  3. Merge + deduplicate, skills_block terms ranked first
"""

import re
import math
import logging
from collections import Counter
from functools import lru_cache
from typing import List, Optional, Set

from app.models.schemas import ParsedResume
from app.services import embedding_service

logger = logging.getLogger("aura")


# ─────────────────────────────────────────────
# STOP WORDS (lightweight, no NLTK needed)
# ─────────────────────────────────────────────

STOP_WORDS = {
"a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "will",
    "am", "if", "then", "else", "when", "where", "while", "so", "than",
    "would", "could", "should", "may", "might", "shall", "can", "that",
    "this", "these", "those", "it", "its", "i", "my", "me", "we", "our",
    "you", "your", "he", "she", "they", "their", "him", "her", "us",
    "which", "who", "whom", "what", "when", "where", "how", "why",
    "all", "any", "each", "every", "both", "few", "more", "most",
    "other", "into", "through", "during", "before", "after", "above",
    "below", "between", "out", "off", "over", "under", "again", "then",
    "once", "here", "there", "not", "no", "nor", "so", "yet", "about",
    "also", "just", "than", "too", "very", "using", "use", "used", 
    "including", "within", "across", "such", "while", "ensure", "work", 
    "working", "worked", "various", "well", "new", "based", "responsible", 
    "key", "role", "team", "experience", "years", "year", "position", 
    "skills", "ability", "knowledge", "strong", "excellent", "good", 
    "proven", "track", "record", "seeking", "looking", "apply", "contribute", 
    "support", "help", "assist", "develop", "developed", "developing", 
    "build", "building", "built", "create", "created", "creating", "manage", 
    "managed", "managing", "lead", "led", "leading", "design", "designed", 
    "designing", "implement", "implemented", "implementing", "provide", 
    "provided", "providing", "ensuring", "improve", "increase", "reduce", 
    "achieved", "achieving", "resulting", "utilising", "utilizing", "adept", 
    "oriented", "driven", "focused", "complex", "innovative", "overall", 
    "cutting", "edge", "present", "percent", "hands", "solving", "both",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    "summary", "education", "certifications", "languages", "awards", 
    "activities", "information", "additional", "contact", "address", 
    "phone", "email", "website", "technologies", "qualifications", "architecture",
    "manila",
    # months / date noise
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
    "oct", "nov", "dec", "january", "february", "march", "april",
    "june", "july", "august", "september", "october", "november", "december",
    # resume section words that leak into keywords
    "summary", "education", "certifications", "languages", "awards",
    "activities", "information", "additional", "contact", "address",
    "phone", "email", "website", "technologies", "qualifications",
}


# ─────────────────────────────────────────────
# TOKENIZER
# ─────────────────────────────────────────────
def _tokenize(text: str) -> List[str]:
    """
    Tokenizes text while preserving hyphens, dots, pluses, and hashes inside terms
    (e.g. 'sd-wan', 'ios-xe', 'c++', 'c#', 'node.js').
    """
    # Regex matches words that may contain internal hyphens/dots or trailing +#
    pattern = r"[a-zA-Z0-9]+(?:[-./][a-zA-Z0-9]+)*[+\#]?"
    tokens = re.findall(pattern, text.lower())
    
    clean_tokens = []
    for t in tokens:
        t = t.strip(".,;:/-")
        if len(t) > 1 and t not in STOP_WORDS and not t.isnumeric():
            clean_tokens.append(t)
            
    return clean_tokens

# ─────────────────────────────────────────────
# SKILLS BLOCK PARSER
# ─────────────────────────────────────────────
# Terms whose "/" is part of the name and must NOT be split apart
# ("CI/CD" is one skill, not "CI" + "CD"; "TCP/IP" is not "TCP" + "IP").
_PROTECTED_SLASH_RE = re.compile(
    r"\b(?:ci/cd|tcp/ip|ui/ux|ux/ui|i/o|a/b|pl/sql|ai/ml|ml/ai|ml/dl)\b", re.I
)
_SLASH_PLACEHOLDER = "\u2044"  # fraction slash, can't appear in normal resume text

# "Programming Languages: Python, Java" -> "Python, Java" (drops the label that
# otherwise gets glued onto the first skill as "Programming Languages: Python").
_SKILL_LABEL_RE = re.compile(r"^[^:\n,]{2,40}:\s*", re.M)


def _parse_skills_block(skills_block: str) -> List[str]:
    """
    Extracts skill phrases without destroying hyphenated technical terms.
    Splits on newlines, commas, pipes, bullets, slashes, or dashes surrounded
    by spaces. Keeps "CI/CD"/"TCP/IP"-style terms whole and strips
    "Category:" labels from the front of each line.
    """
    text = _SKILL_LABEL_RE.sub("", skills_block)
    text = _PROTECTED_SLASH_RE.sub(lambda m: m.group(0).replace("/", _SLASH_PLACEHOLDER), text)

    raw = re.split(r"[\n,;|•\t\/]+|\s+[-–—]\s+", text)
    skills = []

    for item in raw:
        cleaned = item.replace(_SLASH_PLACEHOLDER, "/").strip(" .–-•")
        words = cleaned.lower().split()

        # Reject empty items, single stop words, or phrases made only of stop words
        if cleaned and len(cleaned) > 1:
            if not all(w in STOP_WORDS for w in words):
                skills.append(cleaned)

    return skills


# ─────────────────────────────────────────────
# TF-IDF KEYWORD EXTRACTION
# ─────────────────────────────────────────────

def _tfidf_keywords(text: str, top_n: int = 30) -> List[str]:
    """
    Single-document TF-IDF approximation.
    IDF is approximated using a small hardcoded corpus frequency reference
    so we don't need a full corpus — terms that appear in many resumes
    (e.g. 'experience', 'team') are naturally down-weighted via STOP_WORDS.
    """
    tokens = _tokenize(text)
    if not tokens:
        return []

    total = len(tokens)
    freq = Counter(tokens)

    # TF = count / total tokens
    # We approximate IDF by rewarding less-frequent terms (log-based)
    scored = {}
    for term, count in freq.items():
        tf = count / total
        # Reward rarer terms within the document
        idf = math.log(total / (1 + count))
        scored[term] = tf * idf

    sorted_terms = sorted(scored, key=lambda t: scored[t], reverse=True)
    return sorted_terms[:top_n]


# ─────────────────────────────────────────────
# RECALL-ORIENTED RESUME EXTRACTION HELPERS
# ─────────────────────────────────────────────
# extract_keywords() used to read ONLY the skills block + a unigram TF-IDF
# over experience/summary/certifications, capped at 15. That misses skills
# that live in Projects (the biggest source for students), skills written
# in prose ("built APIs with FastAPI"), multi-word skills ("machine
# learning"), and anything not in the skills block. The tiers below add
# those, while keeping the original skills-block-first ordering so the
# first few keywords (the ones JobMatcher actually sends to JSearch) stay
# the highest-signal ones.

# Extra resume-side vocabulary on top of KNOWN_SKILL_TERMS (which is tuned
# for job postings). Matched against the whole resume body, so a skill
# mentioned anywhere counts even if it never made it into the skills block.
EXTRA_RESUME_TERMS = {
    # languages
    "kotlin", "scala", "dart", "perl", "matlab", "powershell", "shell scripting",
    "objective-c", "vb.net", "assembly", "sql server", "pl/sql", "t-sql",
    # web / frameworks
    "next.js", "nuxt", "svelte", "express.js", "spring boot", "spring", "laravel",
    ".net", "asp.net", "flutter", "react native", "tailwind", "tailwind css",
    "bootstrap", "redux", "jquery", "sass", "webpack", "vite", "nestjs", "symfony",
    "codeigniter", "wordpress", "shopify", "responsive design", "web development",
    "frontend", "front-end", "backend", "back-end", "full stack", "fullstack",
    "restful api", "api", "json", "xml", "yaml", "websocket", "oauth", "jwt",
    "microservices", "mvc", "oop", "object-oriented programming", "design patterns",
    "data structures", "algorithms", "sdlc", "tdd", "orm", "sqlalchemy", "pydantic",
    "uvicorn", "celery", "rabbitmq", "kafka", "redis", "nginx", "apache",
    # mobile
    "android", "ios", "android studio", "xcode", "swiftui", "jetpack compose",
    # data / ml / ai
    "spark", "hadoop", "airflow", "etl", "elt", "power query", "looker", "snowflake",
    "bigquery", "redshift", "numpy", "matplotlib", "seaborn", "jupyter", "statistics",
    "data visualization", "data modeling", "data warehouse", "data cleaning",
    "data pipeline", "dbt", "keras", "opencv", "hugging face", "transformers", "llm",
    "large language models", "rag", "langchain", "prompt engineering",
    "computer vision", "generative ai", "mlops", "xgboost", "scikit-learn",
    "natural language processing", "neural networks", "feature engineering",
    "sentiment analysis", "text classification", "embeddings", "vector database",
    "recommendation system", "time series", "regression", "classification",
    # cloud / devops / infra
    "ec2", "s3", "lambda", "cloudformation", "helm", "github actions", "gitlab ci",
    "prometheus", "grafana", "serverless", "cloud computing", "infrastructure as code",
    "containerization", "virtualization", "vmware", "virtualbox", "hyper-v",
    "ubuntu", "windows", "macos", "git", "github", "gitlab", "bitbucket", "vercel",
    "heroku", "netlify", "digitalocean",
    # databases
    "oracle", "sqlite", "supabase", "firebase", "dynamodb", "elasticsearch",
    "stored procedures", "database design", "database administration", "mariadb",
    "postgres", "query optimization", "indexing", "normalization",
    # security
    "nmap", "metasploit", "burp suite", "splunk", "nist", "iso 27001", "zero trust",
    "iam", "ids/ips", "threat hunting", "digital forensics", "malware analysis",
    "threat intelligence", "vulnerability management", "network security",
    "information security", "security operations", "access control", "soc 2",
    "gdpr", "data privacy", "cryptography", "ethical hacking", "kali linux",
    "security+", "ceh", "oscp", "cysa+", "az-500", "sc-200",
    # testing / qa
    "selenium", "cypress", "playwright", "jest", "pytest", "junit", "postman",
    "test automation", "unit testing", "integration testing", "manual testing",
    "regression testing", "test cases", "bug tracking", "qa", "sdet", "load testing",
    "jmeter", "performance testing", "uat",
    # it support / systems / networking
    "help desk", "service desk", "ticketing", "troubleshooting", "hardware",
    "networking", "system administration", "office 365", "microsoft 365",
    "group policy", "servicenow", "remote support", "backup and recovery",
    "disaster recovery", "patch management", "endpoint management", "intune",
    "sccm", "exchange", "sharepoint", "packet tracer", "gns3", "subnetting",
    "wireless", "wi-fi", "cloud security", "iot",
    # design
    "adobe xd", "photoshop", "illustrator", "canva", "user research",
    "usability testing", "design systems", "user experience", "user interface",
    "information architecture", "user flows", "interaction design", "accessibility",
    "wcag", "invision", "balsamiq", "after effects", "premiere pro",
    # project / business / practice
    "devsecops", "scrum master", "product management", "business analysis",
    "requirements gathering", "process improvement", "technical documentation",
    "stakeholder communication", "client communication", "presentation",
    "ms office", "microsoft office", "word", "powerpoint", "google workspace",
    "crm", "erp", "sap", "salesforce", "seo", "google analytics",
    # degree fields (education block)
    "computer science", "information technology", "information systems",
    "software engineering", "computer engineering", "data science",
    "cybersecurity", "electronics engineering", "business administration",
    "multimedia arts",
    # common role words worth searching on
    "software developer", "web developer", "data analyst", "data engineer",
    "system administrator", "network engineer", "qa engineer", "ui/ux designer",
    "machine learning engineer", "devops engineer", "cloud engineer",
    "technical support", "it support", "intern", "internship", "capstone",
}

# Surface-form aliases collapsed to ONE canonical key so "ReactJS", "React.js"
# and "React" don't burn three keyword slots (and three JSearch queries).
_CANONICAL_ALIASES = {
    "reactjs": "react", "react.js": "react", "react js": "react",
    "vuejs": "vue", "vue.js": "vue", "angularjs": "angular", "angular.js": "angular",
    "nodejs": "node.js", "node": "node.js", "node js": "node.js",
    "nextjs": "next.js", "expressjs": "express.js",
    "postgres": "postgresql", "js": "javascript",
    "k8s": "kubernetes", "ml": "machine learning", "nlp": "natural language processing",
    "amazon web services": "aws", "google cloud": "gcp", "google cloud platform": "gcp",
    "ms excel": "excel", "microsoft excel": "excel", "ms office": "microsoft office",
    "sklearn": "scikit-learn", "scikit learn": "scikit-learn", "powerbi": "power bi",
    "ci cd": "ci/cd", "cicd": "ci/cd", "front-end": "frontend", "back-end": "backend",
    "full stack": "fullstack", "full-stack": "fullstack", "restful api": "rest api",
    "restful apis": "rest api", "apis": "api", "oop": "object-oriented programming",
    "ui ux": "ui/ux", "ux/ui": "ui/ux",
}

# Words that stay upper-case when a vocabulary hit is turned into display text.
_DISPLAY_UPPER = {
    "sql", "aws", "gcp", "css", "html", "api", "etl", "elt", "ci/cd", "tcp/ip",
    "ui", "ux", "ui/ux", "ai", "ml", "nlp", "llm", "rag", "ios", "iam", "vpn",
    "dns", "dhcp", "lan", "wan", "vlan", "bgp", "ospf", "mpls", "voip", "snmp",
    "soc", "siem", "oop", "tdd", "mvc", "sdlc", "seo", "crm", "erp", "sap", "qa",
    "sdet", "bi", "ccna", "ccnp", "ccie", "cissp", "pmp", "itil", "owasp", "rest",
    "json", "xml", "yaml", "orm", "jwt", "oauth", "nist", "gdpr", "iot", "uat",
    "bert", "ceh", "oscp", "wcag", "pl/sql", "t-sql", "ids/ips", "gns3",
    "sccm", "ec2", "s3", "dbt", "xcode", "mlops", "devsecops", "ec2",
}

_TECH_ACRONYM_NOISE = {
    "gpa", "usa", "uk", "ph", "pdf", "llc", "inc", "ltd", "cv", "bsit", "bscs",
    "bsis", "bscpe", "shs", "am", "pm", "ii", "iii", "iv", "ceo", "cto", "hr",
    "phd", "mba", "bs", "ba", "ms", "ma", "ncr", "jr", "sr", "etc", "usd", "php",
    "gwa", "id", "tin", "sss", "ok", "no", "vs", "re", "ex",
}
# "PHP" is a real language but also the Philippine peso; the vocab/skills-block
# tiers still catch it when it's a skill, so it's excluded from the loose
# acronym tier only.

_CAMEL_RE = re.compile(r"\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b")
_DOTTED_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9]*\.(?:js|py|net|io|ai)\b", re.I)
_SYMBOL_RE = re.compile(r"\b[A-Za-z]+(?:\+\+|#)(?![A-Za-z0-9])")
_ACRONYM_RE = re.compile(r"(?<![A-Za-z0-9/.])[A-Z][A-Z0-9]{1,5}(?![A-Za-z0-9/])")
_CAMEL_NOISE = {"linkedin", "youtube", "facebook", "mcdonald", "whatsapp", "tiktok"}

# Requirement-derived single words too generic to count as a resume keyword
# ("testing", "security", "database" appear in nearly every IT resume).
_REQ_GENERIC_SINGLE = {
    "programming", "database", "testing", "security", "networking", "monitoring",
    "privacy", "automation", "audit", "scripting", "scalability", "routing",
    "switching", "troubleshooting", "replication", "governance",
}

_RUNTIME_VOCAB: set[str] = set()


@lru_cache(maxsize=1)
def _requirements_vocab() -> tuple:
    """
    (skills, certifications) from app/data/job_requirements.py - the single
    source of truth for what each role needs - so the resume vocabulary grows
    whenever a role or skill is added there, with no second list to maintain.
    Returns empty sets if that module can't be imported.
    """
    try:
        from app.data.job_requirements import JOB_REQUIREMENTS
    except Exception as exc:  # missing module / bad data must never break extraction
        logger.warning("job_requirements unavailable for resume vocabulary: %s", exc)
        return frozenset(), frozenset()

    skills: set[str] = set()
    certs: set[str] = set()
    for spec in JOB_REQUIREMENTS.values():
        for key, target in (("required_skills", skills), ("optional_skills", skills),
                            ("required_certifications", certs), ("optional_certifications", certs)):
            for term in (spec.get(key) or []):
                t = str(term).strip().lower()
                if len(t) < 3:                       # drops "r"
                    continue
                if " " not in t and t in _REQ_GENERIC_SINGLE:
                    continue
                target.add(t)
    return frozenset(skills), frozenset(certs)


@lru_cache(maxsize=1)
def _full_vocab() -> frozenset:
    skills, certs = _requirements_vocab()
    return frozenset(KNOWN_SKILL_TERMS | EXTRA_RESUME_TERMS | skills | certs | _RUNTIME_VOCAB)


def register_extra_vocab(terms) -> int:
    """
    Add terms to the resume vocabulary at runtime - e.g. at app startup, the
    skill_name values from the Supabase `certifications` table:

        register_extra_vocab(r["skill_name"] for r in rows)

    Returns how many new terms were added.
    """
    before = len(_RUNTIME_VOCAB)
    for t in terms or []:
        if isinstance(t, str) and len(t.strip()) >= 3:
            _RUNTIME_VOCAB.add(t.strip().lower())
    _full_vocab.cache_clear()
    _vocab_regex.cache_clear()
    return len(_RUNTIME_VOCAB) - before


@lru_cache(maxsize=1)
def _vocab_regex() -> "re.Pattern":
    """Built lazily: KNOWN_SKILL_TERMS is defined further down this module, so
    the combined resume vocabulary can't be assembled at import time here."""
    vocab = _full_vocab()
    return re.compile(
        r"(?<![a-z0-9])(?:"
        + "|".join(re.escape(t) for t in sorted(vocab, key=lambda t: (-len(t), t)))
        + r")(?![a-z0-9])"
    )


def _canon(term: str) -> str:
    key = re.sub(r"\s+", " ", term.strip().lower())
    return _CANONICAL_ALIASES.get(key, key)


_DISPLAY_WORD = {
    "comptia": "CompTIA", "istqb": "ISTQB", "cncf": "CNCF", "iso": "ISO", "cism": "CISM",
    "cysa+": "CySA+", "a+": "A+", "network+": "Network+", "security+": "Security+",
    "mitre": "MITRE", "att&ck": "ATT&CK", "vpc": "VPC", "azure": "Azure", "aws": "AWS",
    "sysops": "SysOps", "devops": "DevOps", "vue.js": "Vue.js", "ux": "UX", "ui": "UI",
    "ai": "AI", "sentinel": "Sentinel", "nist": "NIST", "iam": "IAM", "ids/ips": "IDS/IPS",
}

_DISPLAY_OVERRIDE = {
    "sqlalchemy": "SQLAlchemy", "pytest": "pytest", "github actions": "GitHub Actions",
    "github": "GitHub", "gitlab": "GitLab", "gitlab ci": "GitLab CI", "numpy": "NumPy",
    "devops": "DevOps", "postgresql": "PostgreSQL", "mysql": "MySQL", "mongodb": "MongoDB",
    "nosql": "NoSQL", "fastapi": "FastAPI", "javascript": "JavaScript",
    "typescript": "TypeScript", "tensorflow": "TensorFlow", "pytorch": "PyTorch",
    "jquery": "jQuery", "nestjs": "NestJS", "graphql": "GraphQL", "dynamodb": "DynamoDB",
    "bigquery": "BigQuery", "hugging face": "Hugging Face", "langchain": "LangChain",
    "scikit-learn": "scikit-learn", "xgboost": "XGBoost", "opencv": "OpenCV",
    "servicenow": "ServiceNow", "sharepoint": "SharePoint", "powershell": "PowerShell",
    "wordpress": "WordPress", "macos": "macOS", "vmware": "VMware", "wi-fi": "Wi-Fi",
    "fullstack": "Full Stack", "full stack": "Full Stack", "powerpoint": "PowerPoint",
    "photoshop": "Photoshop", "jmeter": "JMeter", "rabbitmq": "RabbitMQ",
    "elasticsearch": "Elasticsearch", "iot": "IoT", "comptia security+": "CompTIA Security+", "supabase": "Supabase", "uvicorn": "Uvicorn",
}


def _display(term: str) -> str:
    if term in _DISPLAY_OVERRIDE:
        return _DISPLAY_OVERRIDE[term]
    return " ".join(
        _DISPLAY_WORD.get(w) or (w.upper() if w in _DISPLAY_UPPER else w.capitalize())
        for w in term.split(" ")
    )


class _KeywordCollector:
    """Ordered, alias-aware, capped keyword list."""

    def __init__(self, limit: int):
        self.limit = limit
        self.seen: set[str] = set()
        self.items: List[str] = []

    def full(self) -> bool:
        return len(self.items) >= self.limit

    def add(self, term: str) -> None:
        term = term.strip(" .,;:-–•")
        if not term or len(term) < 2 or self.full():
            return
        key = _canon(term)
        if key in self.seen or key in STOP_WORDS:
            return
        self.seen.add(key)
        self.items.append(term)


def _vocab_hits(text: str) -> List[str]:
    """Known skill terms found anywhere in `text`, most frequent first."""
    lower = text.lower()
    counts: Counter = Counter()
    first_pos: dict[str, int] = {}
    for m in _vocab_regex().finditer(lower):
        term = m.group(0)
        counts[term] += 1
        first_pos.setdefault(term, m.start())
    ordered = sorted(counts, key=lambda t: (-counts[t], first_pos[t]))
    return [_display(t) for t in ordered]


def _tech_shaped_tokens(text: str) -> List[str]:
    """Original-case tokens that LOOK like technologies: PostgreSQL, FastAPI,
    Next.js, C++, C#. Catches tools the vocabularies have never heard of."""
    found: List[str] = []
    for rx in (_CAMEL_RE, _DOTTED_RE, _SYMBOL_RE):
        for m in rx.finditer(text):
            tok = m.group(0)
            if tok.lower() not in _CAMEL_NOISE:
                found.append(tok)
    return found


def _acronym_tokens(text: str, skills_text: str) -> List[str]:
    """Loose tier: ALL-CAPS tokens (SQL, AWS, REST, SIEM...). Kept if they sit
    in the skills block or appear more than once, minus resume-noise acronyms."""
    counts = Counter(m.group(0) for m in _ACRONYM_RE.finditer(text))
    in_skills = {m.group(0) for m in _ACRONYM_RE.finditer(skills_text or "")}
    out = [
        a for a, c in counts.most_common()
        if a.lower() not in _TECH_ACRONYM_NOISE and not a.isdigit()
        and (a in in_skills or c >= 2)
    ]
    return out


def _repeated_phrases(text: str, max_phrases: int = 12) -> List[str]:
    """Two-word phrases that appear 2+ times ("machine learning", "rest api",
    "data pipeline"), requiring neither word to be a stop word."""
    pattern = r"[a-zA-Z0-9]+(?:[-./][a-zA-Z0-9]+)*[+\#]?"
    counts: Counter = Counter()
    for line in text.lower().split("\n"):
        toks = [t.strip(".,;:/-") for t in re.findall(pattern, line)]
        for a, b in zip(toks, toks[1:]):
            if (len(a) > 1 and len(b) > 1 and a not in STOP_WORDS and b not in STOP_WORDS
                    and not a.isnumeric() and not b.isnumeric()):
                counts[f"{a} {b}"] += 1
    return [p for p, c in counts.most_common() if c >= 2][:max_phrases]


def _certification_names(certs_block: Optional[str], max_items: int = 8) -> List[str]:
    if not certs_block:
        return []
    out = []
    for line in certs_block.split("\n"):
        line = line.strip(" -•\t")
        if 3 <= len(line) <= 60 and 1 <= len(line.split()) <= 8:
            out.append(line)
    return out[:max_items]


# ─────────────────────────────────────────────
# SEMANTIC RESUME TIER, ALIAS VARIANTS, SEARCH-SKILL PICKER
# ─────────────────────────────────────────────

# Stricter than SEMANTIC_SKILL_MATCH_THRESHOLD (0.62, tuned for job postings):
# a wrong skill credited to the RESUME is worse than a missed one, because it
# can end up in a JSearch query. Retune against labelled resumes.
RESUME_SEMANTIC_THRESHOLD = 0.75
RESUME_SEMANTIC_CANDIDATES = 25   # how many TF-IDF candidates to check (cost bound)
RESUME_SEMANTIC_MAX_ADDED = 8     # cap on semantically-inferred keywords per resume
RESUME_SEMANTIC_MIN_LEN = 4


def _semantic_resume_terms(candidates: List[str], seen_keys: set) -> List[str]:
    """
    Maps resume words that are NOT literal skill terms onto the known skill
    they mean ("containerization" -> Docker). Returns display-ready known
    terms to add. No-ops (returns []) if the embedding model is unavailable.
    """
    try:
        if not embedding_service.is_available():
            return []
    except Exception as exc:
        logger.warning("Embedding model unavailable for resume keywords: %s", exc)
        return []

    pool: List[str] = []
    for cand in candidates:
        pkey = cand.lower()
        if len(pkey) < RESUME_SEMANTIC_MIN_LEN or pkey in STOP_WORDS or _canon(pkey) in seen_keys:
            continue
        pool.append(pkey)
        if len(pool) >= RESUME_SEMANTIC_CANDIDATES:
            break
    _prefetch_embeddings(pool)

    added: List[str] = []
    added_keys: set[str] = set()
    checked = 0
    for cand in candidates:
        key = cand.lower()
        if len(key) < RESUME_SEMANTIC_MIN_LEN or key in STOP_WORDS or _canon(key) in seen_keys:
            continue
        if checked >= RESUME_SEMANTIC_CANDIDATES:
            break
        checked += 1
        known, score = _closest_known_skill_scored(key)
        if score < 0:          # model errored: stop instead of failing on every candidate
            break
        if known is None or score < RESUME_SEMANTIC_THRESHOLD:
            continue
        ck = _canon(known)
        if ck in seen_keys or ck in added_keys:
            continue
        logger.info("Semantic resume keyword: %r ~ %r (%.2f)", cand, known, score)
        added_keys.add(ck)
        added.append(_display(known))
        if len(added) >= RESUME_SEMANTIC_MAX_ADDED:
            break
    return added


def alias_variants(skill: str) -> set:
    """
    All lower-case surface forms we treat as the same skill as `skill`
    ("React" -> {"react", "reactjs", "react.js", "react js"}). Used by
    job_scorer so a resume's "ReactJS" matches a posting's "React.js".
    """
    key = _canon(skill)
    variants = {skill.strip().lower(), key}
    variants.update(a for a, c in _CANONICAL_ALIASES.items() if c == key)
    return {v for v in variants if v}


# Terms that are real skills but make poor JSearch queries on their own or
# combined with a role ("Backend Developer Git"), plus degree/role words.
_WEAK_QUERY_TERMS = {
    "microsoft office", "ms office", "microsoft 365", "office 365", "google workspace",
    "problem solving", "communication", "teamwork", "git", "github", "gitlab",
    "bitbucket", "json", "xml", "yaml", "api", "word", "powerpoint", "windows",
    "macos", "ubuntu", "presentation", "stakeholder communication",
    "client communication", "technical documentation", "intern", "internship",
    "capstone", "computer science", "information technology", "information systems",
    "software engineering", "computer engineering", "electronics engineering",
    "business administration", "multimedia arts", "hardware", "wireless", "wi-fi",
    "troubleshooting", "ticketing", "remote support",
    "backend", "frontend", "full stack", "fullstack", "web development", "networking",
}
_ROLE_WORD_RE = re.compile(
    r"\b(developer|engineer|analyst|administrator|designer|architect|specialist|"
    r"technician|manager|intern|tester)\b", re.I
)


def pick_search_skills(keywords: List[str], n: int = 4) -> List[str]:
    """
    Picks the `n` best JSearch-query skills from a ranked keyword list:
    recognised technologies first (in rank order), skipping generic tools,
    degree names and role words. If fewer than `n` are recognised, tops up
    from the first 15 keywords that look like short skill phrases.
    """
    vocab = _full_vocab()
    certs = _requirements_vocab()[1]
    picked: List[str] = []
    picked_keys: set[str] = set()

    def _ok_shape(kw: str) -> bool:
        words = kw.split()
        return 1 <= len(words) <= 2 and len(kw) <= 25 and not _ROLE_WORD_RE.search(kw)

    def _take(kw: str) -> None:
        key = _canon(kw)
        if key in picked_keys or key in _WEAK_QUERY_TERMS or kw.strip().lower() in _WEAK_QUERY_TERMS:
            return
        if key in certs or re.search(r"\b(?:certified|certificate|certification)\b", key):
            return
        picked_keys.add(key)
        picked.append(kw)

    for kw in keywords:
        if len(picked) >= n:
            return picked
        if _ok_shape(kw) and (_canon(kw) in vocab or kw.lower() in vocab):
            _take(kw)

    for kw in keywords[:15]:
        if len(picked) >= n:
            break
        if _ok_shape(kw) and kw.lower() not in STOP_WORDS and not kw.isnumeric():
            _take(kw)
    return picked


# ─────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────

DEFAULT_TOP_N = 40


def extract_keywords(resume: ParsedResume, top_n: int = DEFAULT_TOP_N) -> List[str]:
    """
    PUBLIC ENTRY POINT — this is the function other files (e.g. the route/
    controller that orchestrates the parse -> keywords -> jobs -> enrich
    flow) actually call.

    Returns a ranked list of keywords. Only the FIRST few are used as JSearch
    queries (JobMatcher.max_keywords_queried), so ordering is deliberate —
    highest-signal first — while the long tail gives job scoring/matching
    more vocabulary to work with.

    Priority order:
      1. Skills block terms (explicit, high signal), as written
      2. Known skill terms found ANYWHERE in the resume (projects,
         experience, summary, certifications) — frequency ranked
      3. Technology-shaped tokens (PostgreSQL, FastAPI, Next.js, C#)
      4. Certification / training names
      5. ALL-CAPS acronyms (skills block, or repeated)
      6. Repeated two-word phrases ("machine learning")
      7. Semantic: reworded skills mapped onto known ones (needs the
         embedding model; silently skipped when unavailable)
      8. TF-IDF unigrams over experience + summary + projects + certs
      9. Fallback TF-IDF over full raw_text when still thin

    Aliases ("ReactJS" / "React.js" / "React") share one slot.
    Returns at most `top_n` keywords, deduplicated.
    """
    kw = _KeywordCollector(top_n)

    # Everything except the contact block (names/addresses/emails are noise).
    body = "\n".join(filter(None, [
        resume.summary_block, resume.experience_block, resume.education_block,
        resume.skills_block, resume.projects_block, resume.certifications_block,
    ])) or resume.raw_text or ""

    # ── 1. skills block ───────────────────────
    if resume.skills_block:
        for skill in _parse_skills_block(resume.skills_block):
            # Sentence fragments ("we are a motivated team player...") aren't skills.
            if len(skill) <= 40 and len(skill.split()) <= 5:
                kw.add(skill)

    # ── 2. vocabulary hits anywhere in the resume ──
    for term in _vocab_hits(body):
        kw.add(term)

    # ── 3. technology-shaped tokens ───────────
    for term in _tech_shaped_tokens(body):
        kw.add(term)

    # ── 4. certification names ────────────────
    for name in _certification_names(resume.certifications_block):
        kw.add(name)

    # ── 5. acronyms ───────────────────────────
    for term in _acronym_tokens(body, resume.skills_block or ""):
        kw.add(term)

    # ── 6. repeated two-word phrases ──────────
    for phrase in _repeated_phrases(body):
        kw.add(phrase)

    # TF-IDF candidates are computed once and shared by tiers 7 and 8.
    rich_text = " ".join(filter(None, [
        resume.experience_block,
        resume.summary_block,
        resume.projects_block,
        resume.certifications_block,
    ]))
    tfidf_terms = _tfidf_keywords(rich_text, top_n=40) if rich_text else []

    # ── 7. semantic: map reworded skills onto known ones (best-effort) ──
    for term in _semantic_resume_terms(tfidf_terms, kw.seen):
        kw.add(term)

    # ── 8. TF-IDF unigrams (now includes projects) ──
    for term in tfidf_terms:
        kw.add(term)

    # ── 9. fallback to full raw_text ──────────
    if len(kw.items) < 5:
        for term in _tfidf_keywords(resume.raw_text, top_n=30):
            kw.add(term)

    return kw.items[:top_n]


# ─────────────────────────────────────────────
# JD-SPECIFIC NOISE WORDS
# ─────────────────────────────────────────────
# Unlike STOP_WORDS above (tuned for RESUMES, which use past-tense verbs
# and rarely repeat section headers), job POSTINGS have their own noise
# profile: present-tense imperative bullet verbs ("Configure and maintain
# network hardware") and generic role/section nouns ("Job Description",
# "Roles and Responsibilities"). A single-document TF-IDF pass can't tell
# these apart from real skills because they're often statistically "rare"
# within one posting — this list exists specifically to catch what
# rarity-based scoring cannot.
JD_NOISE_WORDS = {
    # generic JD bullet-point verbs (present-tense, imperative)
    "configure", "install", "evaluate", "maintain", "monitor",
    "troubleshoot", "coordinate", "oversee", "perform", "respond",
    "administer", "review", "deploy", "resolve", "diagnose", "execute",
    "deliver", "drive", "participate", "conduct", "operate", "inspect",
    "document", "upgrade", "patch", "plan", "handle", "prepare",
    "collaborate", "communicate", "recommend", "identify", "analyze",
    "assess", "adhere", "comply", "escalate", "report", "attend",
    # generic role / section / posting-metadata nouns
    "description", "role", "roles", "responsibilities", "requirement",
    "requirements", "qualification", "qualifications", "overview",
    "duties", "duty", "benefit", "benefits", "position", "positions",
    "opportunity", "opportunities", "environment", "environments",
    "organization", "organizations", "solution", "solutions", "company",
    "companies", "department", "departments", "industry", "career",
    "careers", "candidate", "candidates", "employer", "employers",
    "employment", "applicant", "applicants", "engineer", "engineers",
    "specialist", "specialists", "professional", "professionals",
    "level", "levels", "member", "members", "staff", "personnel",
    "individual", "individuals", "someone", "ideal", "job", "jobs",
    "location", "locations", "schedule", "shift", "hours", "salary",
    "compensation", "eeo", "employer", "disability", "veteran",
    "join", "seeking", "required", "preferred", "including",
    "our", "team", "understanding", "solid", "new", "am", "manila",
    "and", "product", "growth", "learn",
    # generic marketing/filler adjectives common in postings — these
    # will never be a complete list (see the note on
    # extract_skill_terms_from_posting's backfill tier below for why
    # relying on the TF-IDF backfill tier less, not just growing this
    # list, is the more durable fix)
    "growth", "high", "low", "one", "two", "three", "clients", "client",
    "quality", "fast", "great", "best", "world", "global", "various",
    "wide", "valued", "valuable", "exciting", "perfect", "rapidly",
    "growing", "dynamic", "passionate", "talented", "diverse",
    "fastest", "largest", "biggest", "leading", "leader",
}

# ─────────────────────────────────────────────
# KNOWN SKILL VOCABULARY
# ─────────────────────────────────────────────
# The positive signal the resume-side STOP_WORDS/TF-IDF approach never
# had: an explicit allowlist of real skill/technology/certification
# terms. A term matching this list against the posting text is treated
# as a skill with no statistics involved — this is deliberately checked
# BEFORE the TF-IDF backfill in extract_skill_terms_from_posting(), since
# an allowlist hit is a much stronger signal than "this word is rare in
# this one document."
#
# This is a starting vocabulary, not an exhaustive one — it will always
# lag behind niche/emerging tools. Treat additions here the same as
# adding a new supported category: cheap, low-risk, and the fastest way
# to fix "why didn't it catch X" bug reports as they come in.
KNOWN_SKILL_TERMS = {
    # networking / IT infrastructure
    "tcp/ip", "dns", "dhcp", "vpn", "lan", "wan", "vlan", "bgp", "ospf",
    "firewall", "router", "routers", "switch", "switches", "routing",
    "switching", "cabling", "network security", "wireshark", "snmp",
    "cisco", "juniper", "fortinet", "palo alto", "ccna", "ccnp", "ccie",
    "network engineering", "load balancing", "network monitoring",
    "sd-wan", "mpls", "voip", "active directory", "windows server",
    # programming / web
    "python", "javascript", "typescript", "java", "c++", "c#", "golang",
    "ruby", "php", "rust", "react", "vue", "angular", "node.js", "html",
    "css", "rest api", "graphql", "fastapi", "django", "flask",
    # cloud / devops
    "aws", "azure", "gcp", "docker", "kubernetes", "ci/cd", "terraform",
    "devops", "linux", "jenkins", "ansible", "bash",
    # data
    "sql", "excel", "tableau", "power bi", "pandas", "data analysis",
    "data analytics", "postgresql", "mysql", "mongodb", "nosql",
    # ml / ai
    "machine learning", "deep learning", "tensorflow", "pytorch", "nlp",
    "bert", "scikit-learn", "artificial intelligence",
    # security
    "cybersecurity", "penetration testing", "owasp", "encryption", "soc",
    "compliance", "cissp", "comptia security+", "siem", "incident response",
    "vulnerability assessment", "risk assessment",
    # project management / business
    "project management", "agile", "scrum", "kanban", "jira", "pmp",
    "stakeholder management", "budget management", "vendor management",
    # design
    "figma", "sketch", "ux", "ui", "wireframing", "prototyping", "adobe",
    # certifications (generic patterns handled separately, common ones here)
    "aws certified", "microsoft certified", "itil",
}

_KNOWN_SKILL_TERMS_SORTED = sorted(KNOWN_SKILL_TERMS)

# Minimum cosine similarity for a TF-IDF candidate term to be credited as
# matching a KNOWN_SKILL_TERMS entry. Tuned conservatively (high) on
# purpose — this feeds a user-facing "your required skills" list, where
# a false positive is a visible, confusing product bug (same precision
# concern the module docstring of extract_skill_terms_from_posting
# already describes for its other tiers). 0.62 was chosen to comfortably
# catch true synonyms/rewordings ("containerization" vs. "docker",
# "React framework" vs. "react") while rejecting merely-related-topic
# terms ("networking" vs. "firewall") — re-tune here if you see it
# over- or under-matching in practice.
SEMANTIC_SKILL_MATCH_THRESHOLD = 0.62

# How many of the posting's own TF-IDF-ranked candidate terms get
# checked against KNOWN_SKILL_TERMS per call. Keeps the semantic pass
# bounded — this is NOT the same as top_n (the function's overall
# output cap); it's just the candidate pool the semantic tier searches
# within before that cap is applied.
SEMANTIC_CANDIDATE_POOL_SIZE = 40


_known_skill_matrix_cache = None


def _known_skill_matrix():
    """Embeds KNOWN_SKILL_TERMS once (one batched call) and keeps the normalized matrix."""
    global _known_skill_matrix_cache
    if _known_skill_matrix_cache is None:
        _known_skill_matrix_cache = embedding_service.normalized_matrix(_KNOWN_SKILL_TERMS_SORTED)
    return _known_skill_matrix_cache


def _prefetch_embeddings(terms) -> None:
    """Embeds many terms in ONE batched call so later per-term lookups hit the cache."""
    try:
        terms = [t for t in terms if t]
        if terms:
            embedding_service.embed(terms)
    except Exception as exc:
        logger.warning("Embedding prefetch skipped: %s", exc)


def _closest_known_skill_scored(candidate: str) -> tuple:
    """(closest KNOWN_SKILL_TERMS entry, cosine score). Fails soft to (None, -1.0)
    - a negative score means "the embedding model errored", not "no match"."""
    try:
        idx, score = embedding_service.best_match_in_matrix(candidate, _known_skill_matrix())
    except Exception as exc:
        logger.warning("Semantic skill match failed for '%s': %s", candidate, exc)
        return None, -1.0
    if idx is None:
        return None, 0.0
    return _KNOWN_SKILL_TERMS_SORTED[idx], score


def _closest_known_skill(candidate: str, threshold: Optional[float] = None) -> Optional[str]:
    """
    Returns the KNOWN_SKILL_TERMS entry `candidate` is semantically
    closest to, if that similarity clears the threshold (default
    SEMANTIC_SKILL_MATCH_THRESHOLD) - otherwise None.

    This is the embedding-similarity upgrade this file's KNOWN_SKILL_TERMS
    vocabulary always needed: a candidate term that means the same thing
    as an existing entry ("containerization" vs. "docker", "IaC" vs.
    "terraform") gets credited too, without listing every synonym by hand.

    Uses embedding_service.cached_semantic_similarity(), which caches each
    individual term's embedding. Fails soft: any error talking to the
    embedding model is logged and treated as "no semantic match".
    """
    best_term, best_score = _closest_known_skill_scored(candidate)
    limit = SEMANTIC_SKILL_MATCH_THRESHOLD if threshold is None else threshold
    return best_term if best_score >= limit else None


def extract_skill_terms_from_posting(
    text: str,
    top_n: int = 20,
    min_terms: int = 0,
    exclude_terms: "set[str] | None" = None,
) -> List[str]:
    """
    PRECISION-oriented skill extraction for JOB POSTINGS specifically —
    used to build the discrete "Required / Optional" skill-gap checklist
    the user reads directly on their dashboard.

    This is deliberately a SEPARATE function from extract_keywords_from_text()
    rather than a shared one, because the two callers have different
    correctness requirements:

      - extract_keywords_from_text() feeds a JSearch/Adzuna search query.
        A stray noise word there just makes the search marginally less
        precise — the user never sees the noise directly. Recall matters
        more than precision.
      - This function feeds a list the user reads as "your required
        skills for this role." A stray noise word here is a visible,
        confusing product bug. Precision matters more than recall.

    Strategy (allowlist-first, not blocklist-only):
      1. Vocabulary match (KNOWN_SKILL_TERMS) — the positive signal.
         Any known skill term found in the text is included, no
         statistics involved. This is what plain TF-IDF/rarity-based
         extraction structurally cannot do: it has no notion of "this
         IS a skill," only "this word is uncommon in this document."
      1.5. Semantic vocabulary match — same idea as step 1, but catches
         candidate terms that MEAN the same thing as a KNOWN_SKILL_TERMS
         entry without being the same string (see _closest_known_skill).
         Optional/best-effort: no-ops cleanly if the local embedding
         model isn't available on this machine (see
         embedding_service.is_available()), so this tier never turns a
         missing dependency into a broken /api/analyze call.
      2. Bullet/comma-separated short phrases (JD requirement lists read
         a lot like resume skills blocks), filtered through JD_NOISE_WORDS
         and exclude_terms.
      3. Statistical TF-IDF backfill — ONLY to top up the list if steps
         1–2 don't reach top_n, and only after the same noise/exclude
         filtering. Never the primary signal.

    Args:
        text: the job posting's raw description text.
        top_n: HARD CAP on terms returned — never exceeded.
         min_terms: optional floor for the statistical backfill tier (step 3).
            The default is 0, which disables statistical guesses for the
            user-facing skill-gap list. Raise it only when recall for
            unfamiliar skills is more important than precision.
        exclude_terms: tokens to always exclude — pass the job's own
            title + company name here, tokenized, so e.g. "Solutions"
            from "SIGINT Solutions, LLC" can never be reported as a
            required skill of that same job.
    """
    if not text:
        return []

    def _normalize(word: str) -> str:
        """
        Lightweight singularization used ONLY for membership checks
        against JD_NOISE_WORDS / exclude_terms (never for display or for
        what actually gets returned) — just enough to catch "firewalls"
        against a vocabulary/exclude entry of "firewall", or "networks"
        against an excluded "network", without pulling in a real stemming
        library for what is a small, cheap check.
        """
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            return word[:-1]
        return word

    exclude = {t.lower() for t in (exclude_terms or set())}
    lower_text = text.lower()

    seen: set[str] = set()
    results: List[str] = []
    # Tracks normalized (singularized) sub-words already returned, so we
    # don't show both "Router" and "Routers", or both "Tcp" and "Tcp/Ip"
    # — same underlying skill, just different surface forms picked up by
    # different passes (vocabulary vs. bullet-parsing vs. TF-IDF backfill).
    seen_words: set[str] = set()

    def _word_blocked(word: str) -> bool:
        norm = _normalize(word)
        return (
            word in exclude or norm in exclude
            or word in JD_NOISE_WORDS or norm in JD_NOISE_WORDS
        )

    def _sub_words(key: str) -> list[str]:
        return re.findall(r"[a-z0-9]+", key)

    def _eligible(key: str) -> bool:
        if key in seen:
            return False
        words = _sub_words(key)
        if not words:
            return False
        # Check every constituent word, not just the whole phrase — a
        # multi-word candidate like "Maintain TCP" must be rejected
        # because "maintain" is noise, even though "maintain tcp" as a
        # whole string isn't itself in JD_NOISE_WORDS.
        if any(_word_blocked(w) for w in words):
            return False
        # Already represented by an earlier, equally-or-more-specific
        # match (e.g. "tcp" after "tcp/ip" already matched; "routers"
        # after "router" already matched).
        if all(_normalize(w) in seen_words for w in words):
            return False
        return True

    def _mark_seen(key: str) -> None:
        seen.add(key)
        for w in _sub_words(key):
            seen_words.add(_normalize(w))

    def _vocab_eligible(term: str) -> bool:
        """
        Eligibility check for TIER 1 (vocabulary matches) only —
        deliberately does NOT apply exclude_terms, unlike _eligible()
        below which tiers 2/3 use.

        Why: exclude_terms exists to strip the job's own title/company
        metadata out of the LOW-confidence candidate pool (bullet
        fragments, statistical guesses) where that metadata is noise —
        e.g. "Engineer" from "Network Engineer", "Solutions" from
        "SIGINT Solutions, LLC". But a vocabulary match is a HIGH-
        confidence, deliberate signal: if the job title is "Senior
        Backend Developer (Python)", the word "Python" appearing in the
        title isn't noise — it's the single most important word in that
        title. Applying exclude_terms here would silently drop the most
        obviously-required skill from the list whenever it happens to
        also appear in the job title, which is common and not a
        coincidence worth filtering out.
        """
        if term in seen:
            return False
        words = _sub_words(term)
        if not words:
            return False
        if any(w in JD_NOISE_WORDS for w in words):
            return False
        if all(_normalize(w) in seen_words for w in words):
            return False
        return True

    # ── 1. Vocabulary-first pass — the positive signal ──────────────────
    for term in KNOWN_SKILL_TERMS:
        if not _vocab_eligible(term):
            continue
        # Allow an optional trailing "s" for single-word terms so
        # "firewall" in the vocabulary still matches "firewalls" in the
        # text, without needing to hand-list every plural.
        pattern = re.escape(term)
        if " " not in term and not term.endswith("s"):
            pattern += "s?"
        if re.search(rf"\b{pattern}\b", lower_text):
            _mark_seen(term)
            results.append(term)

    # ── 1.5. Semantic vocabulary pass — catches synonyms/rewordings the
    #          literal Tier-1 string match misses ("containerization" ~
    #          docker/kubernetes, "React framework" ~ react, "IaC" ~
    #          terraform). Runs over the posting's OWN TF-IDF-ranked
    #          candidate terms (not the full KNOWN_SKILL_TERMS list —
    #          Tier 1 already covers exact matches, so this only adds
    #          NEW signal on top). Applies the same exclude/noise
    #          filtering as tiers 2/3, since this is a softer
    #          (approximate) signal than an exact vocabulary hit, unlike
    #          tier 1 above.
    #
    #          Cleanly skipped (falls straight through to tier 2) if the
    #          local embedding model isn't available on this machine —
    #          see embedding_service.is_available(). The first posting
    #          analyzed after a fresh process start will be a bit slower
    #          here (each of the ~150 KNOWN_SKILL_TERMS gets embedded
    #          and cached the first time it's compared against
    #          anything); every posting after that reuses those cached
    #          embeddings and only pays for its own new candidate terms.
    if embedding_service.is_available():
        _pool_terms = _tfidf_keywords(text, top_n=SEMANTIC_CANDIDATE_POOL_SIZE)
        _prefetch_embeddings([t.lower() for t in _pool_terms])
        for term in _pool_terms:
            key = term.lower()
            if not _eligible(key):
                continue
            matched_known_term = _closest_known_skill(key)
            if matched_known_term:
                _mark_seen(key)
                results.append(term)

    # ── 2. Bullet/comma-separated short phrases ─────────────────────────
    for item in _parse_skills_block(text):
        if not (1 < len(item) <= 40):
            continue
        key = item.lower()
        # Real skill phrases are short (1-3 words). Longer items are
        # sentence fragments the paragraph-splitting picked up (e.g. "LLC
        # is seeking a Network Engineer") — not skills, discard them here
        # rather than trying to noise-filter every possible sentence.
        if len(key.split()) > 3:
            continue
        if _eligible(key):
            _mark_seen(key)
            results.append(item)

    # ── 3. Statistical backfill — only up to min_terms, not top_n ───────
    # This is the key precision/recall trade-off in this function: we'd
    # rather return fewer, trustworthy skills than pad out to top_n with
    # statistical guesses once the high-confidence tiers run dry.
    if len(results) < min_terms:
        for term in _tfidf_keywords(text, top_n=top_n * 3):
            if len(results) >= min_terms:
                break
            if _eligible(term):
                _mark_seen(term)
                results.append(term)

    # Title-case lowercase tokens for display; leave mixed-case terms
    # (e.g. "TCP/IP", "PostgreSQL") exactly as written.
    return [t.title() if t.islower() else t for t in results[:top_n]]


# NOTE on KNOWN_SKILL_TERMS coverage:
# A hardcoded vocabulary will always lag behind niche tools/industries
# not covered above (e.g. specialized medical, legal, or trades
# terminology) — the Tier 1.5 semantic pass above narrows that gap by
# catching terms that MEAN the same thing as an existing entry, but it
# still can't invent a category that has zero related entries in
# KNOWN_SKILL_TERMS to begin with (there's nothing for "specialized
# legal terminology" to be semantically close TO yet). If a whole new
# domain needs supporting, the fastest fix is still the cheap one: add
# a handful of representative terms for that domain to KNOWN_SKILL_TERMS
# — the semantic tier then automatically picks up that domain's
# synonyms/rewordings too, without listing every one of them by hand.

def _single_doc_keyword_rank(text: str, top_n: int = 30) -> List[str]:
    """
    Single-document frequency rank with sub-linear TF scaling.
    Avoids inverted IDF penalties on repeated high-value terms.
    """
    tokens = _tokenize(text)
    if not tokens:
        return []

    counts = Counter(tokens)
    
    # Sub-linear term frequency scaling: 1 + log(count)
    # Rewards terms that appear more frequently without over-saturating
    scored = {term: 1 + math.log(count) for term, count in counts.items()}
    sorted_terms = sorted(scored, key=lambda t: scored[t], reverse=True)
    
    return sorted_terms[:top_n]

def extract_keywords_from_text(text: str, top_n: int = 20) -> List[str]:
    """
    Same TF-IDF approximation as extract_keywords(), but for arbitrary
    free text rather than a ParsedResume — used to pull search-friendly
    keywords out of a user-pasted target job description so job matching
    can be steered toward the role they're actually applying for, not
    just what their resume happens to contain.

    Also runs the skills-block-style splitter over the text first (a
    pasted JD's "Requirements"/"Qualifications" bullet lines behave a lot
    like a skills block — comma/bullet separated short phrases), so
    explicit tool/skill names in the JD are prioritized the same way
    they are for resumes.
    """
    if not text:
        return []

    seen: set[str] = set()
    keywords: List[str] = []

    # Bullet/comma-separated lines often contain the highest-signal terms
    # in a JD (e.g. "Requirements: Python, SQL, AWS, 5+ years...").
    for item in _parse_skills_block(text):
        # Skip long sentence-like lines — those get picked up by TF-IDF below.
        if 1 < len(item) <= 40:
            key = item.lower()
            if key not in seen:
                seen.add(key)
                keywords.append(item)

    for term in _single_doc_keyword_rank(text, top_n=top_n):
        if term not in seen:
            seen.add(term)
            keywords.append(term)

    return keywords[:top_n]