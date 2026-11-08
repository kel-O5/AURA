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
import os
import threading
import time
from typing import Dict, List, Sequence

logger = logging.getLogger("aura")

EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"

# ── Optional speed / safety knobs (all environment variables) ─────────────
#   DISABLE_EMBEDDINGS=true  → skip semantic features entirely; every caller
#                              falls back to rule-based scoring (fastest).
#   EMBED_MAX_CHARS=1500     → only the first N characters of each text are
#                              embedded. Embedding cost grows with length, and
#                              the start of a job description / resume carries
#                              most of the signal.
#   EMBED_THREADS=1          → onnxruntime thread count. On small containers,
#                              lower values can avoid CPU contention.
_DISABLED = os.getenv("DISABLE_EMBEDDINGS", "false").strip().lower() == "true"
_MAX_CHARS = int(os.getenv("EMBED_MAX_CHARS", "1500"))
_THREADS = int(os.getenv("EMBED_THREADS", "0")) or None
_CACHE_MAX = 4000

_model = None
_model_lock = threading.Lock()

# text -> vector. Shared across requests: skill terms, taxonomy terms and
# repeated phrases get embedded once per process instead of once per call.
_vector_cache: Dict[str, List[float]] = {}
_cache_lock = threading.Lock()


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
    if _DISABLED:
        raise RuntimeError("Embeddings disabled via DISABLE_EMBEDDINGS")
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:  # re-check inside the lock (another thread may have loaded it)
            from fastembed import TextEmbedding
            logger.info("Loading embedding model '%s' (onnxruntime backend)...", EMBEDDING_MODEL_NAME)
            if _THREADS:
                _model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME, threads=_THREADS)
            else:
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
    if _DISABLED:
        return False
    try:
        _load_model()
        return True
    except Exception as exc:
        logger.warning("Embedding model unavailable — semantic features will be skipped: %s", exc)
        return False


def embed(texts: Sequence[str]) -> List[List[float]]:
    """
    Embeds a batch of strings into semantic vectors.

    - Texts already embedded earlier in this process come straight from
      the cache; only unseen texts go to the model, together, in ONE
      call.
    - Texts are truncated to EMBED_MAX_CHARS before embedding (and
      before cache lookup), which keeps long job descriptions cheap.
    - Logs how long each model call takes, so slow steps show up in
      the host's logs.

    fastembed's .embed() returns a generator of numpy arrays (one per
    input text), so the result is materialized and converted to plain
    Python floats, matching this module's public return type.
    """
    model = _load_model()
    prepared = [(t or "")[:_MAX_CHARS] for t in texts]

    local: Dict[str, List[float]] = {}
    missing: List[str] = []
    for t in prepared:
        if t in local:
            continue
        cached = _vector_cache.get(t)
        if cached is not None:
            local[t] = cached
        else:
            local[t] = []  # placeholder so duplicates in this batch aren't queued twice
            missing.append(t)

    if missing:
        start = time.perf_counter()
        vectors = list(model.embed(missing))
        for t, v in zip(missing, vectors):
            local[t] = v.tolist()
        elapsed = time.perf_counter() - start
        logger.info(
            "embed: %d new text(s), %d cached, %d chars, %.2fs",
            len(missing), len(local) - len(missing), sum(len(t) for t in missing), elapsed,
        )
        with _cache_lock:
            for t in missing:
                _vector_cache[t] = local[t]
            if len(_vector_cache) > _CACHE_MAX:
                for key in list(_vector_cache)[: _CACHE_MAX // 4]:
                    _vector_cache.pop(key, None)

    return [local[t] for t in prepared]


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
    similarity, in [0, 1] in practice. Because embed() now caches every
    text, repeated comparisons against the same text no longer
    re-embed it.
    """
    vec_a, vec_b = embed([text_a, text_b])
    return cosine_similarity(vec_a, vec_b)


def _cached_embed_one(text: str) -> tuple:
    """Kept for backward compatibility; embed() itself now caches."""
    return tuple(embed_one(text))


def cached_semantic_similarity(text_a: str, text_b: str) -> float:
    """
    Like semantic_similarity(). Kept as a separate name because other
    modules call it; both now share the same process-wide cache.
    """
    vec_a = embed_one(text_a)
    vec_b = embed_one(text_b)
    return cosine_similarity(vec_a, vec_b)


# ── Fast batch matching (numpy) ───────────────────────────────────────────
# Comparing one term against ~150 known skills with pure-Python cosine
# similarity is slow on small CPUs. These helpers embed everything in
# batches and score all pairs with a single matrix multiply.

def _normalized(vectors):
    import numpy as np
    arr = np.asarray(vectors, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def normalized_matrix(texts: Sequence[str]):
    """Embeds texts (one batched call) and returns an L2-normalized matrix, one row per text."""
    return _normalized(embed(list(texts)))


def best_match_in_matrix(query: str, matrix):
    """
    Returns (row_index, cosine_score) of the row in `matrix` (from
    normalized_matrix) closest to `query`, or (None, 0.0) if nothing
    scores above 0.
    """
    import numpy as np
    q = _normalized([embed_one(query)])[0]
    scores = matrix @ q
    idx = int(np.argmax(scores))
    score = float(scores[idx])
    if score <= 0:
        return None, 0.0
    return idx, score


def best_matches(queries: Sequence[str], corpus: Sequence[str]):
    """
    For every query, returns (corpus_index, cosine_score) of its closest
    corpus text, or (None, 0.0) if nothing scores above 0. Queries and
    corpus are each embedded in one batch, then scored with one matrix
    multiply.
    """
    import numpy as np
    if not queries or not corpus:
        return [(None, 0.0) for _ in queries]
    q = _normalized(embed(list(queries)))
    c = _normalized(embed(list(corpus)))
    sims = q @ c.T
    out = []
    for row in sims:
        idx = int(np.argmax(row))
        score = float(row[idx])
        out.append((idx, score) if score > 0 else (None, 0.0))
    return out