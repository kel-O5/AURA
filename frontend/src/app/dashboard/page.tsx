// src/app/dashboard/page.tsx

'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { Info, TrendingUp } from 'lucide-react';

import type { AnalysisResult, TopJob } from '@/types/analysis';
import {
  AnalysisLoadingOverlay,
  AssessmentSidebar,
  CertificationRecommendations,
  CompanyMatchCarousel,
  DashboardChatbot,
  DashboardHeader,
  FormattingReadability,
  JobListings,
  KeyStrengths,
  KeywordSkillOptimization,
  SmartSuggestions,
  Upload,
  type UploadPayload,
} from '@/features/dashboard/components';
import { SettingsBackground } from '@/features/settings/components/SettingsUI';
import { AUTH_CHANGE_EVENT, getStoredUser, isAuthenticated } from '@/lib/auth';
// ADDED: scroll-in animation wrapper (file is src/components/reveal.tsx).
import Reveal from '@/components/reveal';

// Keeps the last analysis across a page refresh (cleared when the tab closes).
// Bumped to v2: the stored value is now the API shape (AnalysisResult), not the old card props.
const STORAGE_KEY = 'aura:last-analysis:v2';

// How many resumes have been analyzed THIS session — a real running count,
// not just "is there a result right now" (which could only ever show 0 or 1
// and would never move again after the first upload). Persisted alongside
// the last result so it survives a refresh, cleared when the tab closes.
const STATS_KEY = 'aura:dashboard-stats:v1';

// Cache keys are scoped to the signed-in user, so one account's last analysis
// can never load for another account (or after logout).
function storageKey(base: string): string | null {
  const id = getStoredUser()?.id;
  return id && isAuthenticated() ? `${base}:${id}` : null;
}

const normalizeName = (s: string) => s.trim().toLowerCase();

// Only http(s) links are kept (URLs come from an external API and end up in href)
const safeUrl = (url: unknown): string | undefined =>
  typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined;

// The best-scoring job at a company, used when the API doesn't send `top_job_url` itself
function findTopJobUrl(company: string, jobs: TopJob[]): string | undefined {
  const name = normalizeName(company);
  if (!name) return undefined;

  const best = jobs
    .filter((job) => safeUrl(job.url) && normalizeName(job.company ?? '').includes(name))
    .sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0))[0];

  return best?.url;
}

// Maps the backend response to AnalysisResult (the shape DashboardHeader / Export PDF also use).
// Accepts the alternative key names the page used before, so an older cached result still loads.
// Adjust the keys here if your FastAPI response names them differently.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toResult(raw: Record<string, any>): AnalysisResult {
  const topJobs: TopJob[] = raw.top_jobs ?? [];

  return {
    keywords: raw.keywords ?? [],
    total_jobs: raw.total_jobs ?? topJobs.length,
    top_jobs: topJobs,
    // Each company gets its job link: from the API if present, otherwise from top_jobs
    companies: (raw.companies ?? []).map((c: AnalysisResult['companies'][number]) => ({
      ...c,
      top_job_url: safeUrl(c.top_job_url) ?? findTopJobUrl(c.company, topJobs),
    })),
    ats_score: Math.round(raw.ats_score ?? raw.score ?? 0),
    sections: raw.sections ?? raw.dimensions ?? [],
    strengths: raw.strengths ?? [],
    improvements: raw.improvements ?? raw.suggestions ?? [],
    skill_gaps: raw.skill_gaps ?? raw.skillGaps ?? [],
    keyword_gaps: raw.keyword_gaps ?? [],
    grammar_issues: raw.grammar_issues ?? raw.grammarIssues ?? [],
    certifications: raw.certifications ?? [],
  };
}

async function analyzeResume({ file, jobTitle, companies, internshipOnly }: UploadPayload): Promise<AnalysisResult> {
  const body = new FormData();
  body.append('file', file);
  body.append('target_job', jobTitle);
  body.append('target_companies', companies);
  // Form field read by POST /api/analyze in the backend; true = internship postings only.
  body.append('internship_only', String(internshipOnly ?? false));

  // Use the same field names and Authorization header as the fetch in your current
  // loading page — this goes through the Next.js proxy at app/api/analyze/route.ts.
  let res: Response;
  try {
    res = await fetch('/api/analyze', { method: 'POST', body });
  } catch {
    // fetch only throws when the request never reached the server (offline, server down).
    throw new Error(
      'Could not reach the server. Check your internet connection and try again.'
    );
  }

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.detail ?? "We couldn't analyze that resume. Please try again.");
  }
  return toResult(await res.json());
}

function loadResumesAnalyzed(): number {
  try {
    const key = storageKey(STATS_KEY);
    if (!key) return 0;
    const raw = sessionStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const n = Number(parsed?.resumesAnalyzed);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveResumesAnalyzed(count: number) {
  try {
    const key = storageKey(STATS_KEY);
    if (key) sessionStorage.setItem(key, JSON.stringify({ resumesAnalyzed: count }));
  } catch {
    // Not being able to persist is fine; the in-memory count still shows.
  }
}

// One summary tile in the stats row ("Resumes Uploaded", "Jobs Targeted", "Match Score")
// CHANGED: wrapped in <Reveal> (h-full keeps the tiles the same height in the row).
function StatCard({
  label,
  value,
  hint,
  delay = 0,
}: {
  label: string;
  value: string | number;
  hint: string;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className="h-full">
      <div className="flex h-full flex-col gap-3 rounded-[20px] border-[1.5px] border-white bg-white/[0.72] p-5 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px]">
        <p className="text-[13px] font-medium text-[#4b5563]">{label}</p>
        <div className="flex items-end justify-between gap-3">
          <p className="text-[32px] font-extrabold leading-none text-[#111827]">{value}</p>
          <span className="flex items-center gap-1 rounded-full bg-[#10b981]/10 px-2 py-1 text-[10px] font-bold text-[#10b981]">
            <TrendingUp className="size-3" />
            {hint}
          </span>
        </div>
      </div>
    </Reveal>
  );
}

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const [result, setResult] = useState<AnalysisResult | null>(null);
  // Starts true when opening a saved analysis (?analysis=<id>) so the loading
  // overlay shows straight away instead of flashing the empty dashboard.
  const [isAnalyzing, setIsAnalyzing] = useState(() => searchParams.get('analysis') !== null);
  const [error, setError] = useState<string | null>(null);
  // Real running count of analyses this session (see loadResumesAnalyzed above) —
  // not derived from `result`, since `result` only ever holds the LATEST analysis
  // and would make this number regress if the user re-analyzed an older resume.
  const [resumesAnalyzed, setResumesAnalyzed] = useState(0);

  // "View Results" on the Resume History page links here as /dashboard?analysis=<id>
  const analysisId = searchParams.get('analysis');

  // Restore the session's resume count, then either open the saved analysis
  // the URL points at (from Resume History) or the last analysis after a refresh.
  useEffect(() => {
    setResumesAnalyzed(loadResumesAnalyzed());

    if (analysisId) {
      const controller = new AbortController();

      (async () => {
        try {
          const res = await fetch(`/api/analysis-history/${encodeURIComponent(analysisId)}`, {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error(err?.detail ?? "We couldn't load that saved analysis.");
          }
          const saved = toResult(await res.json());
          setResult(saved);
          try {
            // Keep it across a refresh, same as a fresh analysis.
            const key = storageKey(STORAGE_KEY);
            if (key) sessionStorage.setItem(key, JSON.stringify(saved));
          } catch {
            // Not being able to persist is fine; the results still show.
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setError(e instanceof Error ? e.message : "We couldn't load that saved analysis.");
        } finally {
          if (!controller.signal.aborted) setIsAnalyzing(false);
        }
      })();

      return () => controller.abort();
    }

    try {
      const key = storageKey(STORAGE_KEY);
      const saved = key ? sessionStorage.getItem(key) : null;
      if (saved) setResult(toResult(JSON.parse(saved)));
    } catch {
      // Storage unavailable or corrupted: start from the empty state.
    }
  }, [analysisId]);

  // Logging out (or a 401) fires AUTH_CHANGE_EVENT: wipe whatever is on screen
  // so the previous user's resume never lingers while the page is still mounted.
  useEffect(() => {
    const onAuthChange = () => {
      if (isAuthenticated()) return;
      setResult(null);
      setResumesAnalyzed(0);
      setError(null);
      setIsAnalyzing(false);
    };
    window.addEventListener(AUTH_CHANGE_EVENT, onAuthChange);
    return () => window.removeEventListener(AUTH_CHANGE_EVENT, onAuthChange);
  }, []);

  const handleAnalyze = async (payload: UploadPayload) => {
    setIsAnalyzing(true);
    setError(null);
    try {
      const next = await analyzeResume(payload);
      setResult(next);
      try {
        const key = storageKey(STORAGE_KEY);
        if (key) sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not being able to persist is fine; the results still show.
      }
      setResumesAnalyzed((prev) => {
        const updated = prev + 1;
        saveResumesAnalyzed(updated);
        return updated;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const hasResult = result !== null;

  // Highest individual company match %, when there are company matches to
  // compare. Falls back to the resume's own overall ATS score so the tile
  // never shows a bare "-" just because this particular analysis returned
  // no company matches (e.g. a very niche target job/company list).
  const topCompanyMatch =
    result && result.companies.length > 0
      ? Math.round(Math.max(...result.companies.map((c) => c.match)))
      : null;
  const matchScoreValue = topCompanyMatch ?? (result ? Math.round(result.ats_score) : null);
  const matchScoreHint = topCompanyMatch !== null ? 'Top company fit' : 'Overall ATS score';

  // Total job openings actually found for the latest analysis (the same
  // number JobListings' own header shows) — NOT the number of companies
  // matched, which is what this tile used to show under the "Jobs Targeted"
  // label.
  const jobsTargeted = result ? result.total_jobs : 0;

  return (
    // A <div>, not <main>: ConditionalLayout already wraps every page in <main>
    <div className="relative min-h-screen w-full overflow-hidden bg-[#f0eeff]">
      {/* Ambient background orbs + top accent line (same as Settings) */}
      <SettingsBackground />
      <DashboardChatbot />

      {/* Top padding leaves room for the fixed Navbar.
          Full width with the same side padding as the History page (px-6 md:px-20). */}
      <div className="relative z-10 flex w-full flex-col gap-6 px-6 pb-16 pt-28 md:px-20">
        {/* Header: greeting from the stored user + working Export PDF
            CHANGED: wrapped in <Reveal> */}
        <Reveal>
          <DashboardHeader result={result} />
        </Reveal>

        {/* Upload card + assessment sidebar
            CHANGED: the whole grid is wrapped in one <Reveal> (not each card), so the
            grid keeps stretching both cards to the same height exactly as before. */}
        <Reveal delay={0.1}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
            <Upload onAnalyze={handleAnalyze} isAnalyzing={isAnalyzing} error={error} />
            <AssessmentSidebar score={result?.ats_score ?? null} sections={result?.sections} />
          </div>
        </Reveal>

        {/* Summary stats (each tile reveals with a small stagger) */}
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Resumes Uploaded"
            value={resumesAnalyzed}
            hint={resumesAnalyzed > 0 ? 'This session' : 'Upload to begin'}
            delay={0.15}
          />
          <StatCard
            label="Jobs Targeted"
            value={jobsTargeted}
            hint={
              result && result.companies.length > 0
                ? `${result.companies.length} ${result.companies.length === 1 ? 'company' : 'companies'} matched`
                : 'No targets yet'
            }
            delay={0.25}
          />
          <StatCard
            label="Match Score"
            value={matchScoreValue !== null ? `${matchScoreValue}%` : '-'}
            hint={matchScoreValue !== null ? matchScoreHint : 'No score yet'}
            delay={0.35}
          />
        </div>

        {/* Results appear only after a resume has been analyzed.
            Unchanged: this block already has its own fade-in (motion.div), so it is not
            wrapped in <Reveal>, to avoid animating twice. */}
        {result ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="flex flex-col gap-6"
          >
            <div className="grid gap-6 md:grid-cols-2">
              <KeyStrengths strengths={result.strengths} />
              <SmartSuggestions improvements={result.improvements} />
            </div>
            <KeywordSkillOptimization
              items={result.keyword_gaps?.length ? result.keyword_gaps : result.skill_gaps}
            />
            <CertificationRecommendations certifications={result.certifications ?? []} />
            <FormattingReadability grammarIssues={result.grammar_issues} />
            <CompanyMatchCarousel companies={result.companies} />
            <JobListings
              jobs={result.top_jobs}
              totalJobs={result.total_jobs}
              keywords={result.keywords}
            />
          </motion.div>
        ) : (
          // CHANGED: empty-state card wrapped in <Reveal>
          <Reveal delay={0.45}>
            <div className="flex items-start gap-3 rounded-[16px] border-[1.5px] border-white bg-white/[0.72] px-5 py-4 backdrop-blur-[12px]">
              <span className="mt-[1px] flex size-6 shrink-0 items-center justify-center rounded-full bg-[#7c3aed]/[0.08]">
                <Info className="size-3.5 text-[#9ca3af]" />
              </span>
              <div className="flex flex-col gap-[2px]">
                <p className="text-[13px] font-bold text-[#111827]">No data available yet</p>
                <p className="text-[12px] text-[#9ca3af]">
                  Upload your first resume to generate scores, insights, and personalized
                  recommendations.
                </p>
              </div>
            </div>
          </Reveal>
        )}
      </div>

      {/* Full-screen loading state while the request is running */}
      {isAnalyzing && <AnalysisLoadingOverlay />}
    </div>
  );
}