# FILE LOCATION: app/main.py
"""
PURPOSE
-------
This is the FastAPI application entry point for the "Aura" resume
analyzer backend. It's the file that gets started up to run the whole
API server — it wires together configuration, CORS, routers, and the
top-level endpoints.

Run with:
    python -m uvicorn app.main:app --reload --port 8000

Production (Render):
    uvicorn app.main:app --host 0.0.0.0 --port $PORT

HOW IT FITS INTO THE PROGRAM
-----------------------------
This file is the hub that connects everything else together:
  - `app/config.py`                        → app-wide settings (CORS
                                              origins, upload limits,
                                              Supabase/JWT/Adzuna keys).
  - `app/api/v1/endpoints/auth.py`         → auth-related routes
                                              (signup/login/etc.),
                                              mounted under `/api`.
  - `app/routes/parsing.py`                → resume-parsing routes,
                                              also mounted under `/api`.
  - `app/api/routes/jobs.py`               → GET /api/jobs/supported —
                                              lists the target-job roles
                                              with a skill checklist.
                                              Migrated from backend_2.
  - `app/api/routes/resumes.py`            → GET /api/resumes/{id}/analyze
                                              — re-fetches a stored
                                              resume's target-job gap.
                                              Migrated from backend_2.
  - `app/controllers/analyze_controller.py`→ the actual logic behind
                                              `POST /api/analyze`
                                              (this file just wires the
                                              HTTP layer to it).
  - `app/dependencies/auth.py`             → `get_current_user`, a
                                              FastAPI dependency that
                                              authenticates the request
                                              before `analyze_resume`
                                              runs.
  - `app/models/auth_schemas.py`           → the `AuthUser` type
                                              returned by that
                                              dependency.

REQUEST FLOW FOR /api/analyze
-------------------------------
1. Client sends a multipart POST with a resume `file`, optional
   `target_job` text, and optional `target_companies` (JSON string).
2. `get_current_user` dependency runs first — this validates the
   caller is authenticated before any resume processing happens.
3. `handle_analyze(...)` in `analyze_controller.py` does the real
   work, now also receiving `user.id` so the persisted resume row
   (see analyze_controller._persist_parsed_resume) is correctly
   attributed to the requesting user.

NOTES / THINGS WORTH DOUBLE-CHECKING
--------------------------------------
- `load_dotenv()` runs before the `app.config` import, which is
  correct — env vars need to be loaded into the process before
  `Settings()` (in config.py) reads them at import time.
- CORS is intentionally scoped down to only "GET"/"POST" and the two
  headers this API actually needs, rather than wildcarding methods
  and headers — see the inline note above the middleware for the
  reasoning.
- Logging: this module imports the shared `logger` from
  `app/utils/logger.py` — the same "aura" logger used by
  `analyze_controller.py` and the other service modules — rather than
  configuring its own separate `logging.basicConfig(...)`, so log
  format/level is controlled in one place for the whole app.
"""

import os
import threading

from fastapi import FastAPI, UploadFile, File, Form, Depends
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Load .env into the process environment BEFORE anything below (like
# app.config.settings) tries to read environment variables.
load_dotenv()

from app.config import settings
from app.api.v1.endpoints import auth as auth_router
from app.routes.parsing import router as parsing_router
from app.api.routes.jobs import router as jobs_router
from app.api.routes.resumes import router as resumes_router
from app.api.routes.analysis_history import router as analysis_history_router
from app.controllers.analyze_controller import handle_analyze
from app.dependencies.auth import get_current_user
from app.models.auth_schemas import AuthUser

# Use the same shared "aura" logger every other service module uses
# (analyze_controller.py, resume_parser.py, etc. all import this exact
# object via `from app.utils.logger import logger`). main.py previously
# ran its own logging.basicConfig(...) + logging.getLogger(__name__),
# which meant anything logged from this file didn't share format/level
# with the rest of the app, and any handler/level change made in one
# setup silently didn't apply to the other.
from app.utils.logger import logger

# The FastAPI app instance — this is what uvicorn actually runs
# (referenced as "app.main:app" in the run command above).
app = FastAPI(title="Aura Resume Analyzer", version="1.0.0")



from app.services.embedding_service import is_available as _warm_embeddings


@app.on_event("startup")
def _warm_up_embedding_model():
    # On small hosts (e.g. Render free tier, 512 MB RAM) loading the
    # embedding model at boot can run the service out of memory.
    # Set WARM_EMBEDDINGS=false there to load it lazily instead.
    if os.getenv("WARM_EMBEDDINGS", "true").lower() == "true":
        threading.Thread(target=_warm_embeddings, daemon=True).start()


# Reads from settings.ALLOWED_ORIGINS (app/config.py) instead of a
# hardcoded list, so prod/dev can differ via .env without touching code.
# Methods/headers are scoped to what this API actually uses — "*" here
# means any site with the right Origin can send any method with any
# headers, which is more permissive than a resume-analysis API needs.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


# Mount the auth routes (login/signup/etc.), resume-parsing routes,
# and the two migrated-from-backend_2 routers (jobs, resumes) — all
# under the shared "/api" prefix.
app.include_router(auth_router.router, prefix="/api")
app.include_router(parsing_router, prefix="/api")
app.include_router(jobs_router, prefix="/api")
app.include_router(resumes_router, prefix="/api")
app.include_router(analysis_history_router, prefix="/api")


@app.post("/api/analyze")
async def analyze_resume(
    file: UploadFile = File(...),
    target_job: str = Form(default=""),
    target_companies: str = Form(default="[]"),
    internship_only: bool = Form(default=False),
    user: AuthUser = Depends(get_current_user),
):
    """
    Main entry point for the resume-analysis feature.

    - `file`: the uploaded resume (PDF/DOCX — validated later by
      file_handler.validate_file inside the controller/parsing flow).
    - `target_job`: optional IT job title(s), comma-separated when several
      are chosen ("Backend Developer, Data Engineer"). Blank = Any. Also
      used to look up a role-specific skill checklist — see
      app/services/target_job_matcher.py.
    - `target_companies`: optional company names, comma-separated (a JSON
      list is accepted too). Blank = Any. Comes in as a raw string since
      this is a multipart form field — parsed inside handle_analyze.
    - `internship_only`: optional flag (form field, "true"/"false"). When
      true, JSearch is queried for internship postings only — see
      JSearchClient.fetch_jobs(internship_only=...).
    - `user`: injected by the `get_current_user` dependency, which
      runs BEFORE this function body — so unauthenticated requests
      never reach handle_analyze at all. `user.id` is now passed
      through so the persisted resume row is attributed to them.

    All actual logic is delegated to `handle_analyze` in
    analyze_controller.py; this function is just the HTTP-layer glue.
    """
    return await handle_analyze(
        file,
        target_job,
        target_companies,
        user_id=user.id,
        internship_only=internship_only,
    )


@app.get("/health")
def health():
    """Simple liveness/readiness check — used by uptime monitors, load
    balancers, or Docker/orchestration health checks to confirm the
    server process is up and responding."""
    return {"status": "ok"}