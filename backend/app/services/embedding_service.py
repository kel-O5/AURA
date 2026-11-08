# app/services/embedding_service.py
"""
Shared sentence-embedding (BERT-family) service for the Aura backend.

WHY THIS FILE EXISTS
---------------------
Every scoring dimension today (job_scorer.py, keyword_extractor.py,
target_job_matcher.py, resume_enricher.py) is deliberately rule-based:
TF-IDF, regex, token/set overlap. That's great for explainability, but
it means "React.js", "ReactJS", and "React framework" are three
unrelated tokens to the system even though they're the same skill.

`sentence-transformers` is already assumed present in requirements.txt
(see the NOTE at the bottom of keyword_extractor.py) but nothing in the
codebase loads it yet. This module is the ONE place that does:

  - loads the model exactly once per process (loading is the expensive
    part — a few seconds — so it must not happen per-request)
  - exposes small, single-purpose helpers other services call into,
    instead of every service managing its own model instance
  - is designed to be additive, not a replacement: callers should keep
    computing their existing rule-based score AND add a semantic score
    alongside it, so the thesis's explainability story stays intact —
    "here is the literal keyword overlap; here is a separate semantic
    similarity signal we blend in" is auditable, a raw cosine number
    on its own is not.
  - degrades gracefully: if the model can't load (missing dependency,
    no internet on first run to download weights, low-memory host),
    is_available() returns False and callers fall back to rule-based
    scoring only — a semantic feature going down should never take
    /api/analyze down with it.

MODEL CHOICE — AND WHY THIS FILE USES fastembed, NOT sentence-transformers
----------------------------------------------------------------------------
The original version of this module used `sentence-transformers`, which
requires PyTorch. On this project's dev machine, PyTorch's native DLLs
(torch_global_deps.dll etc.) are blocked outright by the machine's
Windows Application Control policy — the same class of restriction
already noted elsewhere in this project (it's also why uvicorn has to
be run via `python -m uvicorn` instead of the bare `uvicorn` command).
No amount of Python-level retrying fixes that; it's the OS refusing to
execute the DLL before our code ever runs.

`fastembed` (from Qdrant) runs the SAME KIND of model — a BERT-family
sentence encoder — through `onnxruntime` instead of PyTorch. Different
native library, much smaller DLL surface, no torch anywhere in its
dependency tree. It gives us functionally the same semantic embeddings
with a real chance of not tripping the same policy block. If
`onnxruntime`'s DLL ever gets blocked too, the underlying constraint is
OS-level, not fixable in Python — see the note in the module docstring
below about WSL2/Docker as the real workaround in that case.

Default model here is `BAAI/bge-small-en-v1.5` (fastembed's own
default): 384-dim output, ~130MB, CPU-only, no GPU required — same
performance ballpark as the MiniLM model this replaces.

SETUP
------
Add to requirements.txt (if not already there):
    fastembed>=0.3.0

First run downloads the model weights from Hugging Face — after that
they're cached locally (~/.cache/fastembed by default), so subsequent
starts are fast and work offline. If the download itself is blocked
by a network/firewall policy (separate from the DLL issue), the model
name can be swapped for one already cached, or downloaded once on an
unrestricted network and copied into the cache dir.

IF onnxruntime's DLL ALSO GETS BLOCKED:
This would mean the Application Control policy blocks native DLLs
broadly, not just torch specifically. At that point the fix isn't
another Python library — it's running the backend somewhere the
Windows policy doesn't apply: WSL2 (Windows Subsystem for Linux) runs
actual Linux ELF binaries, which Windows Application Control / WDAC
does not govern, so `pip install` + uvicorn inside a WSL2 Ubuntu
environment sidesteps this category of block entirely. Docker Desktop
(if permitted) achieves the same isolation. Either way — this
restriction is specific to THIS machine; a normal Linux deployment
target (a VPS, Render, Railway, etc.) was never going to hit it.
"""

import logging
import threading
from functools import lru_cache
from typing import List, Sequence

logger = logging.getLogger("aura")

EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"

_model = None
_model_lock = threading.Lock()


def _load_model():
    """
    Lazily loads the fastembed (onnxruntime-backed) model exactly
    once, thread-safely (FastAPI can serve requests on multiple
    threads).

    Lazy on purpose: importing this module should never pay the load
    cost in code paths that don't end up needing embeddings, and a
    missing/broken install shouldn't crash the whole app at import
    time — it should only affect the specific semantic feature that
    tries to use it (see is_available() below).
    """
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:  # re-check inside the lock (another thread may have loaded it)
            from fastembed import TextEmbedding
            logger.info("Loading embedding model '%s' (onnxruntime backend)...", EMBEDDING_MODEL_NAME)
            _model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)
            logger.info("Embedding model loaded.")
    return _model


def is_available() -> bool:
    """
    True if the embedding model loaded successfully (or can be loaded
    now). Every caller elsewhere in the app that wants to ADD a
    semantic signal should check this first (or call one of the
    functions below inside a try/except) and fall back to its
    existing rule-based-only behavior otherwise — semantic scoring is
    always an enhancement, never a hard dependency of /api/analyze.
    """
    try:
        _load_model()
        return True
    except Exception as exc:
        logger.warning("Embedding model unavailable — semantic features will be skipped: %s", exc)
        return False


def embed(texts: Sequence[str]) -> List[List[float]]:
    """
    Embeds a batch of strings into semantic vectors in ONE model call.
    Prefer this over calling embed_one() in a loop whenever you have
    more than one text to embed — batching amortizes model overhead
    and is significantly faster (e.g. embedding a resume once against
    N job descriptions: embed([resume_text, *job_texts]) in one call).

    fastembed's .embed() returns a generator of numpy arrays (one per
    input text, streamed lazily) rather than a single batch array —
    list(...) + .tolist() below materializes and converts them to
    plain Python floats, matching this module's public return type.
    """
    model = _load_model()
    vectors = list(model.embed(list(texts)))
    return [v.tolist() for v in vectors]


def embed_one(text: str) -> List[float]:
    """Convenience wrapper for embedding a single string."""
    return embed([text])[0]


def cosine_similarity(vec_a: Sequence[float], vec_b: Sequence[float]) -> float:
    """
    Cosine similarity between two vectors. For sentence-transformer
    embeddings of related text this lands roughly in [0, 1] in
    practice (1 = same meaning, 0 = unrelated).

    Pure Python on purpose — avoids pulling in numpy as a hard
    dependency just for this one operation, since the vectors here are
    short (384 dims).
    """
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = sum(a * a for a in vec_a) ** 0.5
    norm_b = sum(b * b for b in vec_b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def semantic_similarity(text_a: str, text_b: str) -> float:
    """
    One-shot convenience: embeds both strings and returns their cosine
    similarity, in [0, 1] in practice.

    For REPEATED comparisons against the same text (e.g. one resume
    checked against many job descriptions, or many skill-taxonomy
    terms checked against the same resume), don't call this in a loop
    — it re-embeds both sides every call. Instead call embed() once
    per unique text and reuse the vectors with cosine_similarity(), or
    use cached_semantic_similarity() below for the taxonomy-term case.
    """
    vec_a, vec_b = embed([text_a, text_b])
    return cosine_similarity(vec_a, vec_b)


@lru_cache(maxsize=512)
def _cached_embed_one(text: str) -> tuple:
    """
    Cached single-text embedding for strings that get compared
    repeatedly across many resumes within the same process — e.g. the
    fixed category keywords in resume_enricher.SKILL_TAXONOMY, or the
    fixed skill lists in job_requirements.JOB_REQUIREMENTS. Returns a
    tuple (hashable, required for lru_cache) instead of a list.
    """
    return tuple(embed_one(text))


def cached_semantic_similarity(text_a: str, text_b: str) -> float:
    """
    Like semantic_similarity(), but skips re-embedding text_a (or
    text_b) if it's been seen before in this process — use this when
    one side of the comparison is drawn from a small, repeating,
    fixed set of terms (a taxonomy category, a skill list), which is
    the common case in this codebase.
    """
    vec_a = _cached_embed_one(text_a)
    vec_b = _cached_embed_one(text_b)
    return cosine_similarity(vec_a, vec_b)