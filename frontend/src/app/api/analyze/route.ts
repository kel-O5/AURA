import { NextRequest, NextResponse } from "next/server";

// Proxies the resume upload from the Next.js frontend to the FastAPI backend.
// This is needed because the browser can't call localhost:8000 directly in
// production, and to avoid CORS issues in development.
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

// Let Vercel keep this route running while the backend analyzes the resume.
// Analysis can take minutes on a small backend. If your Vercel plan rejects
// this value at deploy time, lower it (for example to 60).
export const maxDuration = 300;

// Stop waiting just before Vercel's limit so the user gets a clear message
// instead of an endless spinner.
const BACKEND_TIMEOUT_MS = 290_000;

export async function POST(req: NextRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    // The access token lives in an httpOnly cookie (set by
    // /api/auth/signin and /api/auth/signup), so it's invisible to
    // client-side JS — that's intentional, it protects against XSS
    // stealing the token. But it means THIS server-side route has to
    // read it from the cookie jar and forward it manually; fetch()
    // does not do this automatically.
    const accessToken = req.cookies.get("sb_access_token")?.value;

    if (!accessToken) {
      // No point calling the backend if we already know it'll 401 —
      // return a clean error the frontend can react to (e.g. redirect
      // to /signin) instead of surfacing FastAPI's generic message.
      return NextResponse.json(
        { detail: "You must be signed in to analyze a resume." },
        { status: 401 }
      );
    }

    // Forward the raw FormData (file + fields) straight to FastAPI
    const formData = await req.formData();

    const backendRes = await fetch(`${BACKEND_URL}/api/analyze`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData,
      signal: controller.signal,
      // Do NOT set Content-Type — fetch sets it automatically with the
      // correct multipart boundary when body is FormData
    });

    // The backend normally returns JSON, but a sleeping or crashed host can
    // return an HTML error page. Read it as text first so that doesn't throw.
    const raw = await backendRes.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = {
        detail: `The analysis server returned an unexpected response (status ${backendRes.status}). It may be waking up — please wait a minute and try again.`,
      };
    }

    if (!backendRes.ok) {
      return NextResponse.json(data, { status: backendRes.status });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.error("[api/analyze] backend timed out");
      return NextResponse.json(
        { detail: "The analysis is taking too long. Please try again in a moment." },
        { status: 504 }
      );
    }
    console.error("[api/analyze] proxy error:", err);
    return NextResponse.json(
      { detail: "Could not reach the analysis server. It may be starting up — please try again in a minute." },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}