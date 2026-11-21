# ==============================================================================
# FILE LOCATION: app/api/routes/analysis_history.py
# ==============================================================================
#
# PURPOSE:
#   Read side of the "Resume History" page. Every POST /api/analyze already
#   persists a row in `resumes` and one in `analysis_results`; these routes
#   expose them back to the signed-in user.
#
#   GET /api/analysis-history?page=1&page_size=6
#       -> one summary row per past analysis (newest first) + total count.
#   GET /api/analysis-history/{analysis_id}
#       -> the full analysis in the same shape POST /api/analyze returns, so
#          the dashboard can re-render it ("View Results").
#
# Every query is scoped with .eq("user_id", user.id): supabase_admin bypasses
# RLS, so this ownership check is what keeps users out of each other's data.
# ==============================================================================

import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query
from postgrest.types import CountMethod

from app.data.certification_catalog import get_certification_url
from app.dependencies.auth import get_current_user
from app.extensions.supabase_client import supabase_admin
from app.models.auth_schemas import AuthUser
from app.utils.logger import logger

router = APIRouter(prefix="/analysis-history", tags=["Analysis History"])


def _company_names(matches: Any) -> List[str]:
    """Unique company names from the stored company_matches JSON, in order."""
    names: List[str] = []
    for match in matches or []:
        if not isinstance(match, dict):
            continue
        name = str(match.get("company") or "").strip()
        if name and name not in names:
            names.append(name)
    return names


def _resume_of(row: Dict[str, Any]) -> Dict[str, Any]:
    """The embedded `resumes` row (PostgREST may return a dict or a 1-item list)."""
    resume = row.get("resumes")
    if isinstance(resume, list):
        resume = resume[0] if resume else None
    return resume if isinstance(resume, dict) else {}


@router.get("", summary="List the signed-in user's past analyses")
def list_analysis_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(6, ge=1, le=50),
    user: AuthUser = Depends(get_current_user),
):
    start = (page - 1) * page_size
    end = start + page_size - 1

    try:
        response = (
            supabase_admin.table("analysis_results")
            .select(
                "id, resume_id, ats_score, detected_role, company_matches, "
                "created_at, resumes(filename, target_job, target_companies)",
                count=CountMethod.exact,
            )
            .eq("user_id", user.id)
            .order("created_at", desc=True)
            .range(start, end)
            .execute()
        )
    except Exception:
        logger.exception("Failed to load analysis history (user_id=%s)", user.id)
        raise HTTPException(
            status_code=500,
            detail="Could not load your resume history. Please try again.",
        )

    rows: List[Dict[str, Any]] = [
        r for r in (getattr(response, "data", None) or []) if isinstance(r, dict)
    ]

    items = []
    for row in rows:
        resume = _resume_of(row)
        items.append(
            {
                "id": str(row["id"]),
                "resume_id": str(row["resume_id"]) if row.get("resume_id") else None,
                "filename": resume.get("filename") or "Untitled resume",
                "created_at": row.get("created_at"),
                "target_job": resume.get("target_job") or row.get("detected_role") or "",
                "target_companies": resume.get("target_companies") or [],
                "matched_companies": _company_names(row.get("company_matches")),
                "ats_score": row.get("ats_score") or 0,
            }
        )

    total = getattr(response, "count", None)
    if total is None:
        total = start + len(items)

    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/{analysis_id}", summary="Re-open one past analysis")
def get_analysis(
    analysis_id: str,
    user: AuthUser = Depends(get_current_user),
):
    # A non-UUID would make Postgres throw (-> 500); it is simply "not found".
    try:
        uuid.UUID(analysis_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Analysis not found")

    try:
        response = (
            supabase_admin.table("analysis_results")
            .select(
                "*, resumes(filename, target_job, target_companies, created_at)"
            )
            .eq("id", analysis_id)
            .eq("user_id", user.id)
            .limit(1)
            .execute()
        )
    except Exception:
        logger.exception("Failed to load analysis %s (user_id=%s)", analysis_id, user.id)
        raise HTTPException(
            status_code=500,
            detail="Could not load that analysis. Please try again.",
        )

    rows = getattr(response, "data", None) or []
    if not rows or not isinstance(rows[0], dict):
        raise HTTPException(status_code=404, detail="Analysis not found")
    row: Dict[str, Any] = rows[0]
    resume = _resume_of(row)

    # Preferred: the complete payload saved at analysis time.
    payload = row.get("result_json")
    if isinstance(payload, dict):
        # Analyses saved before certification links existed have no `url`;
        # fill it in from the catalog so old results get links too.
        certs = payload.get("certifications")
        if isinstance(certs, list):
            payload = {
                **payload,
                "certifications": [
                    {**c, "url": c.get("url") or get_certification_url(str(c.get("name", "")))}
                    if isinstance(c, dict) else c
                    for c in certs
                ],
            }
        return {
            **payload,
            "analysis_id": str(row["id"]),
            "resume_id": row.get("resume_id"),
            "filename": (
                resume.get("filename")
                or payload.get("filename")
                or payload.get("resume_filename")
                or "Untitled resume"
            ),
            "uploaded_at": resume.get("created_at"),
            "created_at": row.get("created_at"),
            "target_job": (
                resume.get("target_job")
                or payload.get("target_job")
                or row.get("detected_role")
                or ""
            ),
            "target_companies": (
                resume.get("target_companies")
                or payload.get("target_companies")
                or []
            ),
        }

    # Fallback for rows saved before 003_analysis_result_payload.sql: rebuild
    # what the columns still hold. top_jobs / total_jobs / certifications were
    # never stored for these, so the dashboard shows those sections empty.
    sections = [
        {"name": name, "value": row[col]}
        for name, col in (
            ("Keywords", "keyword_score"),
            ("Format", "formatting_score"),
            ("Skills", "skills_score"),
        )
        if row.get(col) is not None
    ]
    return {
        "analysis_id": str(row["id"]),
        "resume_id": row.get("resume_id"),
        "filename": resume.get("filename") or "Untitled resume",
        "uploaded_at": resume.get("created_at"),
        "created_at": row.get("created_at"),
        "target_job": (
            resume.get("target_job") or row.get("detected_role") or ""
        ),
        "target_companies": resume.get("target_companies") or [],
        "keywords": row.get("extracted_skills") or [],
        "total_jobs": 0,
        "top_jobs": [],
        "companies": row.get("company_matches") or [],
        "ats_score": row.get("ats_score") or 0,
        "sections": sections,
        "strengths": row.get("strengths") or [],
        "improvements": row.get("improvements") or [],
        "skill_gaps": row.get("skill_gaps") or [],
        "grammar_issues": row.get("grammar_issues") or [],
        "certifications": [],
    }