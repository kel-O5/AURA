'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Check,
  Download,
  FileText,
  Lightbulb,
  Loader2,
  ShieldCheck,
  Sparkles,
  Target,
  TriangleAlert,
} from 'lucide-react';

import type { AnalysisResult } from '@/types/analysis';
import { toResult } from '@/lib/analysisResult';
import { getStoredUser } from '@/lib/auth';
import { useExportPdf } from '@/lib/useExportPdf';

type SavedAnalysis = AnalysisResult & {
  id?: string;
  filename?: string;
  uploaded_at?: string;
  created_at?: string;
  target_job?: string;
  target_companies?: unknown[];
};

type AnyRecord = Record<string, any>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;

  if (typeof value === 'number') return String(value);

  if (isRecord(value)) {
    return String(
      value.description ??
        value.text ??
        value.message ??
        value.name ??
        value.title ??
        value.skill ??
        ''
    );
  }

  return '';
}

function getName(value: unknown): string {
  if (typeof value === 'string') return value;

  if (isRecord(value)) {
    return String(
      value.name ??
        value.company_name ??
        value.company ??
        value.title ??
        value.full_name ??
        ''
    );
  }

  return '';
}

function getDescription(value: unknown): string {
  if (typeof value === 'string') return value;

  if (isRecord(value)) {
    return String(
      value.description ??
        value.reason ??
        value.details ??
        value.message ??
        value.text ??
        ''
    );
  }

  return '';
}

function getScore(value: unknown): number | null {
  if (!isRecord(value)) return null;

  const possible = [
    value.score,
    value.match_score,
    value.match,
    value.percentage,
  ];

  for (const item of possible) {
    const parsed = Number(item);

    if (item !== null && item !== undefined && item !== '' && Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, parsed));
    }
  }

  // Saved jobs carry total_score (0-1 or 0-100), which is what the PDF prints.
  const total = Number(value.total_score);

  if (value.total_score != null && Number.isFinite(total)) {
    return Math.round(Math.max(0, Math.min(100, total <= 1 ? total * 100 : total)));
  }

  return null;
}

function formatDate(value?: string) {
  if (!value) return 'Analysis date unavailable';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Analysis date unavailable';
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getStatus(score: number) {
  if (score >= 85) {
    return {
      label: 'Optimized',
      className: 'bg-emerald-50 text-emerald-500',
    };
  }

  if (score >= 70) {
    return {
      label: 'Good',
      className: 'bg-cyan-50 text-cyan-600',
    };
  }

  if (score >= 50) {
    return {
      label: 'Needs improvement',
      className: 'bg-amber-100 text-amber-600',
    };
  }

  return {
    label: 'Needs work',
    className: 'bg-red-100 text-red-600',
  };
}

function getScoreDescription(score: number, targetJob: string) {
  if (score >= 85) {
    return `This resume has strong ATS compatibility for the selected ${targetJob} role.`;
  }

  if (score >= 70) {
    return `This resume has good ATS compatibility for the selected ${targetJob} role, with some areas that can still be improved.`;
  }

  if (score >= 50) {
    return `This resume has moderate ATS compatibility for ${targetJob}. Review the identified gaps and recommendations.`;
  }

  return `This resume has several areas that can be improved for the selected ${targetJob} role.`;
}

function normalizeSkillList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === 'string') return item;

      if (isRecord(item)) {
        return String(
          item.skill ??
            item.name ??
            item.title ??
            item.keyword ??
            item.text ??
            ''
        );
      }

      return '';
    })
    .map((item) => item.trim())
    .filter(Boolean);
}

type MixedTerm = {
  skill: string;
  missing: boolean;
  recommendation: string;
  companies: string[];
};

// One mixed list of skills + keywords from the top five companies; each term
// carries the companies whose postings asked for it. Falls back to the older
// skill_gaps array for analyses saved before keyword_gaps existed.
function getMixedTerms(result: AnyRecord): MixedTerm[] {
  const source =
    Array.isArray(result.keyword_gaps) && result.keyword_gaps.length > 0
      ? result.keyword_gaps
      : Array.isArray(result.skill_gaps)
        ? result.skill_gaps
        : [];

  const seen = new Set<string>();
  const terms: MixedTerm[] = [];

  source.forEach((item: unknown) => {
    if (!isRecord(item)) return;
    const skill = String(item.skill ?? item.name ?? '').trim();
    if (!skill || seen.has(skill.toLowerCase())) return;
    seen.add(skill.toLowerCase());
    terms.push({
      skill,
      missing: item.missing === true,
      recommendation: String(item.recommendation ?? ''),
      companies: Array.isArray(item.source_companies)
        ? item.source_companies.map(String).filter(Boolean)
        : [],
    });
  });

  return terms;
}

function getSkillData(result: AnyRecord) {
  const raw = result.skill_gaps;

  const matched: string[] = [];
  const required: string[] = [];
  const optional: string[] = [];

  if (isRecord(raw)) {
    matched.push(
      ...normalizeSkillList(
        raw.matched_skills ??
          raw.matched ??
          raw.present ??
          raw.existing_skills
      )
    );

    required.push(
      ...normalizeSkillList(
        raw.missing_required_skills ??
          raw.required ??
          raw.missing_required
      )
    );

    optional.push(
      ...normalizeSkillList(
        raw.missing_optional_skills ??
          raw.optional ??
          raw.missing_optional
      )
    );
  }

  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (typeof item === 'string') {
        required.push(item);
        return;
      }

      if (!isRecord(item)) return;

      const name = String(
        item.skill ?? item.name ?? item.title ?? item.keyword ?? ''
      ).trim();

      if (!name) return;

      const missing =
        item.missing === true ||
        item.status === 'missing' ||
        item.status === 'gap';

      const isOptional =
        item.required === false ||
        item.type === 'optional' ||
        item.category === 'optional';

      if (missing) {
        if (isOptional) {
          optional.push(name);
        } else {
          required.push(name);
        }
      } else {
        matched.push(name);
      }
    });
  }

  return {
    matched: [...new Set(matched)],
    required: [...new Set(required)],
    optional: [...new Set(optional)],
  };
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => textValue(item).trim())
    .filter(Boolean);
}

function normalizeCompanies(value: unknown): AnyRecord[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord);
}

function normalizeCertifications(value: unknown): AnyRecord[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord);
}

function normalizeJobs(value: unknown): AnyRecord[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord);
}

export default function AnalysisHistoryDetailPage() {
  // The folder may be named [analysisId] or [id]; read whichever one exists so the
  // page never waits forever for a parameter that is named differently.
  const params = useParams<Record<string, string | string[]>>();

  const rawAnalysisId = params?.analysisId ?? params?.id ?? Object.values(params ?? {})[0];
  const analysisId = Array.isArray(rawAnalysisId) ? rawAnalysisId[0] : rawAnalysisId;

  const [analysis, setAnalysis] = useState<SavedAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Shared by every Export PDF button: spinner -> download -> short cooldown.
  const { isExporting, isBusy, exportPdf } = useExportPdf();
  const [firstName, setFirstName] = useState('');

  useEffect(() => {
    const storedUser = getStoredUser();

    if (storedUser?.full_name) {
      setFirstName(storedUser.full_name.trim().split(' ')[0] ?? '');
    }
  }, []);

  useEffect(() => {
    if (!analysisId) {
      // No id in the URL: show an error instead of loading forever.
      setError('This analysis link is missing its ID.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    // Give up after 30 seconds so a stuck request can never keep the spinner forever.
    const timeout = window.setTimeout(() => controller.abort(), 30_000);

    async function loadAnalysis() {
      setLoading(true);
      setError('');

      try {
        const response = await fetch(
          `/api/analysis-history/${encodeURIComponent(analysisId)}`,
          {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const body = await response.text();

          throw new Error(
            body || `Failed to load analysis (${response.status})`
          );
        }

        const raw = await response.json();

        /*
         * The history endpoint may return either:
         *
         * 1. the saved result directly
         * 2. a database row containing result_json
         *
         * This supports both formats.
         */
        let source: AnyRecord;

        if (
          isRecord(raw) &&
          isRecord(raw.result_json)
        ) {
          source = {
            ...raw.result_json,
            ...raw,
          };
        } else {
          source = raw;
        }

        const parsed = toResult(source) as SavedAnalysis;

        /*
         * Preserve metadata that may exist outside result_json.
         */
        parsed.id = String(source.id ?? analysisId);
        parsed.filename = String(
          source.filename ??
            source.resume_filename ??
            parsed.filename ??
            'Resume'
        );

        parsed.created_at = String(
          source.created_at ??
            source.analyzed_at ??
            parsed.created_at ??
            ''
        );

        parsed.uploaded_at = String(source.uploaded_at ?? '');

        parsed.target_job = String(
          source.target_job ??
            source.selected_job ??
            parsed.target_job ??
            ''
        );

        if (Array.isArray(source.target_companies)) {
          parsed.target_companies = source.target_companies;
        }

        if (!cancelled) {
          setAnalysis(parsed);
        }
      } catch (err) {
        console.error('Failed to load saved analysis:', err);

        if (!cancelled) {
          setError(
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Loading this analysis took too long. Please try again.'
              : err instanceof Error
              ? err.message
              : 'Unable to load this saved analysis.'
          );
        }
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadAnalysis();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [analysisId]);

  const handleExport = () => {
    if (!analysis) return;
    void exportPdf(() => analysis, getStoredUser());
  };

  const view = useMemo(() => {
    if (!analysis) return null;

    const result = analysis as AnyRecord;

    const atsScore = Math.max(
      0,
      Math.min(100, Number(result.ats_score ?? 0))
    );

    const targetJob =
      String(result.target_job ?? '').trim() || 'General Analysis';

    const filename =
      String(result.filename ?? '').trim() || 'Resume';

    const companies = normalizeCompanies(result.companies);

    const strengths = normalizeList(result.strengths);

    const improvements = normalizeList(result.improvements);

    const grammarIssues = Array.isArray(result.grammar_issues)
      ? result.grammar_issues
      : [];

    const certifications = normalizeCertifications(
      result.certifications
    );

    const topJobs = normalizeJobs(result.top_jobs);

    const keywords = normalizeSkillList(result.keywords);

    const skillData = getSkillData(result);

    const mixedTerms = getMixedTerms(result);

    const status = getStatus(atsScore);

    return {
      result,
      atsScore,
      targetJob,
      filename,
      companies,
      strengths,
      improvements,
      grammarIssues,
      certifications,
      topJobs,
      keywords,
      skillData,
      mixedTerms,
      status,
    };
  }, [analysis]);

  if (loading) {
    return (
      <div className="min-h-screen bg-indigo-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="size-14 rounded-full bg-gradient-to-br from-violet-600 to-violet-400 flex items-center justify-center shadow-lg">
            <Loader2 className="size-7 text-white animate-spin" />
          </div>

          <p className="text-gray-600 text-sm font-semibold font-['DM_Sans']">
            Loading saved analysis...
          </p>
        </div>
      </div>
    );
  }

  if (error || !analysis || !view) {
    return (
      <div className="min-h-screen bg-indigo-50 flex items-center justify-center px-6">
        <div className="w-full max-w-lg p-8 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md text-center">
          <div className="mx-auto mb-5 size-12 rounded-2xl bg-red-100 flex items-center justify-center">
            <TriangleAlert className="size-6 text-red-600" />
          </div>

          <h1 className="text-gray-900 text-xl font-extrabold font-['DM_Sans']">
            Unable to load this analysis
          </h1>

          <p className="mt-2 text-gray-600 text-sm font-['DM_Sans'] leading-6">
            {error || 'The saved analysis could not be found.'}
          </p>

          <Link
            href="/analysis-history"
            className="mt-6 inline-flex items-center gap-2 px-5 py-3 rounded-full bg-violet-500 text-white text-sm font-bold font-['DM_Sans'] hover:bg-violet-600 transition"
          >
            <ArrowLeft className="size-4" />
            Back to History
          </Link>
        </div>
      </div>
    );
  }

  const {
    result,
    atsScore,
    targetJob,
    filename,
    companies,
    strengths,
    improvements,
    grammarIssues,
    certifications,
    topJobs,
    keywords,
    skillData,
    mixedTerms,
    status,
  } = view;

  const selectedCompanies = companies
    .map((company) => getName(company))
    .filter(Boolean);

  const displayedCompanies = selectedCompanies.slice(0, 3);
  const moreCompanies = Math.max(
    0,
    selectedCompanies.length - displayedCompanies.length
  );

  const matchedCount = mixedTerms.filter((t) => !t.missing).length;

  const keywordCoverage =
    mixedTerms.length > 0
      ? Math.round((matchedCount / mixedTerms.length) * 100)
      : keywords.length > 0
        ? 100
        : 0;

  const savedSections =
    Array.isArray(result.sections) && result.sections.length > 0
      ? result.sections
      : ['Keywords', 'Format', 'Skills', 'Impact', 'Length'].map((name) => ({
          name,
          value: null,
        }));

  const dimensionItems = savedSections.map((section) => ({
    name: section.name,
    score:
      typeof section.value === 'number' && Number.isFinite(section.value)
        ? Math.max(0, Math.min(100, section.value))
        : undefined,
  }));

  // Top Company Matches: best five by score, same rule as the exported PDF.
  const topCompanies = companies
    .map((company) => ({
      name: getName(company),
      score: getScore(company),
      reason: getDescription(company),
    }))
    .filter((company) => company.name)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5);

  // Feedback Report Summary: a written summary if one was saved, otherwise the
  // same generated text the exported PDF uses.
  const missingTermCount = mixedTerms.filter((t) => t.missing).length;
  const writtenSummary = String(result.summary ?? result.feedback_summary ?? '').trim();
  const bestCompany = topCompanies[0];
  const feedbackSummary =
    writtenSummary ||
    `Your resume scored ${atsScore}% on ATS compatibility. ` +
      `${strengths.length} key strength(s) and ${improvements.length} priority improvement(s) were identified` +
      (missingTermCount ? `, with ${missingTermCount} keyword/skill gap(s) to close` : '') +
      (bestCompany && bestCompany.score !== null
        ? `. Your strongest company match is ${bestCompany.name} at ${Math.round(bestCompany.score)}%.`
        : '.');

  return (
    <div className="min-h-screen relative bg-indigo-50 overflow-hidden">
      {/* Background decorations */}
      <div className="size-[660px] left-[-80px] top-[-90px] fixed opacity-60 bg-violet-300 rounded-full blur-[82.5px] pointer-events-none" />

      <div className="size-[560px] right-[-100px] top-[260px] fixed opacity-50 bg-cyan-200 rounded-full blur-3xl pointer-events-none" />

      <div className="size-[480px] left-[520px] top-[1160px] fixed opacity-25 bg-red-300 rounded-full blur-[80px] pointer-events-none" />

      <div className="size-[520px] right-[-80px] top-[1850px] fixed opacity-30 bg-cyan-200 rounded-full blur-[85px] pointer-events-none" />

      {/* Top gradient */}
      <div className="h-[3px] bg-gradient-to-r from-violet-600 via-cyan-500 to-violet-500/0" />

      <main className="relative z-10 w-full max-w-[1440px] mx-auto px-6 lg:px-20 pt-5 pb-14">
        {/* ========================= */}
        {/* NAVIGATION */}
        {/* ========================= */}

        <div className="h-16 pl-6 pr-3.5 py-3.5 bg-white/80 rounded-[999px] shadow-[0px_8px_32px_0px_rgba(31,41,55,0.06)] outline outline-1 outline-offset-[-1px] outline-white backdrop-blur-[10px] flex justify-between items-center overflow-hidden">
          <div className="flex items-center gap-2.5">
            <div className="size-7 relative flex justify-center items-center overflow-hidden">
              <div className="size-7 absolute bg-gradient-to-br from-violet-600 to-violet-400 rounded-full" />
              <div className="size-3.5 bg-white/40 rounded-full relative" />
            </div>

            <div className="text-gray-900 text-xl font-bold font-['DM_Sans']">
              Aura
            </div>
          </div>

          <div className="hidden md:flex items-center gap-9">
            <Link
              href="/dashboard"
              className="text-gray-600 text-sm font-semibold font-['DM_Sans'] hover:text-gray-900 transition"
            >
              Dashboard
            </Link>

            <Link
              href="/analysis-history"
              className="flex flex-col items-center gap-1.5"
            >
              <span className="text-gray-900 text-sm font-bold font-['DM_Sans']">
                History
              </span>

              <span className="w-5 h-0.5 bg-violet-500 rounded-full" />
            </Link>

            <Link
              href="/ai-mode"
              className="text-gray-600 text-sm font-semibold font-['DM_Sans'] hover:text-gray-900 transition"
            >
              AI Mode
            </Link>

            <Link
              href="/settings"
              className="text-gray-600 text-sm font-semibold font-['DM_Sans'] hover:text-gray-900 transition"
            >
              Settings
            </Link>
          </div>

          <div className="px-2.5 flex items-center gap-3">
            <div className="size-10 rounded-full bg-violet-100 flex items-center justify-center overflow-hidden">
              <span className="text-violet-600 font-bold font-['DM_Sans']">
                {firstName?.charAt(0)?.toUpperCase() || 'A'}
              </span>
            </div>

            <div className="hidden sm:flex flex-col gap-0.5">
              <div className="text-gray-900 text-sm font-semibold font-['DM_Sans']">
                {firstName || 'User'}
              </div>

              <div className="text-gray-400 text-xs font-normal font-['DM_Sans']">
                AURA User
              </div>
            </div>
          </div>
        </div>

        {/* ========================= */}
        {/* HEADER */}
        {/* ========================= */}

        <div className="mt-8 flex flex-col gap-5">
          <div className="flex justify-between items-center">
            <Link
              href="/analysis-history"
              className="flex items-center gap-2 text-violet-500 text-sm font-bold font-['DM_Sans'] hover:text-violet-700 transition"
            >
              <ArrowLeft className="size-4" />
              Back to History
            </Link>
          </div>

          <div className="flex justify-between items-start gap-6">
            <div className="flex-1 flex flex-col gap-2.5 min-w-0">
              <div className="flex items-center gap-3">
                <div className="size-10 bg-red-100 rounded-2xl flex justify-center items-center">
                  <FileText className="size-5 text-red-600" />
                </div>

                <h1 className="text-gray-900 text-2xl md:text-4xl font-extrabold font-['DM_Sans'] truncate">
                  {filename}
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-gray-600 text-sm font-normal font-['DM_Sans']">
                  Uploaded{' '}
                  {formatDate(analysis.uploaded_at || analysis.created_at)}
                </span>

                <span className="text-gray-400">•</span>

                <span className="text-gray-900 text-sm font-bold font-['DM_Sans']">
                  {targetJob}
                </span>

                {displayedCompanies.map((company) => (
                  <span
                    key={company}
                    className="px-2.5 py-[5px] bg-gray-100 rounded-full text-gray-600 text-xs font-bold font-['DM_Sans']"
                  >
                    {company}
                  </span>
                ))}

                {moreCompanies > 0 && (
                  <span className="px-2.5 py-[5px] bg-violet-500/10 rounded-full text-violet-500 text-xs font-bold font-['DM_Sans']">
                    +{moreCompanies} companies
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleExport}
              disabled={!analysis || isBusy}
              className="flex items-center gap-2 self-start rounded-[12px] border-[1.5px] border-[#e3e5eb] bg-white/[0.72] px-5 py-3 text-sm font-medium text-[#454a54] shadow-[0px_2px_8px_0px_rgba(0,0,0,0.05)] backdrop-blur-[12px] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white/[0.72]"
            >
              {isExporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}

              {isExporting ? 'Exporting...' : 'Export PDF'}
            </button>
          </div>
        </div>

        {/* ========================= */}
        {/* OVERALL + DIMENSIONS */}
        {/* ========================= */}

        <div className="mt-8 grid lg:grid-cols-[380px_1fr] gap-6">
          {/* Overall assessment */}

          <div className="p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <div className="text-gray-600 text-xs font-bold font-['DM_Sans'] uppercase">
                Overall assessment
              </div>

              <div
                className={`px-2.5 py-[5px] rounded-full text-xs font-bold font-['DM_Sans'] ${status.className}`}
              >
                {status.label}
              </div>
            </div>

            <div className="flex items-center gap-5">
              <div className="size-36 shrink-0 relative flex justify-center items-center">
                <div className="absolute inset-0 rounded-full bg-gray-200/50" />

                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: `conic-gradient(from 0deg, #8b5cf6, #06b6d4 ${
                      atsScore * 3.6
                    }deg, transparent ${atsScore * 3.6}deg)`,
                  }}
                />

                <div className="absolute inset-[8px] rounded-full bg-white flex flex-col justify-center items-center">
                  <div className="text-gray-900 text-4xl font-extrabold font-['DM_Sans']">
                    {atsScore}%
                  </div>

                  <div className="text-gray-400 text-[9px] font-bold font-['DM_Sans'] uppercase">
                    ATS Score
                  </div>
                </div>
              </div>

              <div className="flex-1 flex flex-col gap-2">
                <div className="text-gray-900 text-xl font-extrabold font-['DM_Sans']">
                  {atsScore >= 85
                    ? 'Excellent match'
                    : atsScore >= 70
                      ? 'Good match'
                      : 'Needs improvement'}
                </div>

                <div className="text-gray-600 text-xs font-normal font-['DM_Sans'] leading-5">
                  {getScoreDescription(atsScore, targetJob)}
                </div>
              </div>
            </div>

            <div className="p-3 bg-violet-500/10 rounded-2xl outline outline-1 outline-violet-600/20 flex items-center gap-2">
              <Sparkles className="size-3.5 text-violet-500 shrink-0" />

              <div className="flex-1 text-violet-500 text-xs font-semibold font-['DM_Sans']">
                This score reflects the saved resume analysis for{' '}
                {targetJob}.
              </div>
            </div>
          </div>

          {/* Dimension Analysis */}

          <div className="p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md flex flex-col gap-5">
            <div className="flex justify-between items-center">
              <div>
                <div className="text-gray-900 text-xl font-extrabold font-['DM_Sans']">
                  Dimension Analysis
                </div>

                <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                  Saved scoring from this analysis
                </div>
              </div>

              <div className="px-2.5 py-[5px] bg-violet-500/10 rounded-full text-violet-500 text-xs font-bold font-['DM_Sans']">
                ATS {atsScore}%
              </div>
            </div>

            <div className="flex flex-col gap-3.5">
              {dimensionItems.map((dimension) => (
                <div
                  key={dimension.name}
                  className="flex items-center gap-3.5"
                >
                  <div className="w-28 text-gray-900 text-xs font-bold font-['DM_Sans']">
                    {dimension.name}
                  </div>

                  <div className="flex-1 h-2 bg-gray-200/50 rounded-full overflow-hidden">
                    {dimension.score !== undefined && (
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-cyan-500 rounded-full"
                        style={{
                          width: `${dimension.score}%`,
                        }}
                      />
                    )}
                  </div>

                  <div className="w-11 text-right text-gray-900 text-xs font-extrabold font-['DM_Sans']">
                    {dimension.score !== undefined
                      ? `${Math.round(dimension.score)}%`
                      : '-'}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-4 py-3 bg-cyan-500/10 rounded-2xl flex items-center gap-2.5">
              <Target className="size-4 text-cyan-500 shrink-0" />

              <div className="flex-1 text-gray-600 text-xs font-semibold font-['DM_Sans']">
                These are the saved section scores shown on the dashboard.
                Dimensions without a stored numeric score are not fabricated.
              </div>
            </div>
          </div>
        </div>

        {/* ========================= */}
        {/* TOP COMPANY MATCHES */}
        {/* ========================= */}

        <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md">
          <div className="flex items-center gap-3.5 mb-5">
            <div className="size-10 bg-violet-500/10 rounded-2xl outline outline-1 outline-violet-500/20 flex justify-center items-center">
              <Building2 className="size-5 text-violet-500" />
            </div>

            <div>
              <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                Top Company Matches
              </div>

              <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                Companies that best fit this resume
              </div>
            </div>
          </div>

          {topCompanies.length > 0 ? (
            <div className="flex flex-col gap-3">
              {topCompanies.map((company, index) => (
                <div
                  key={`${company.name}-${index}`}
                  className="p-4 bg-white/60 rounded-2xl outline outline-1 outline-white"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-gray-900 text-sm font-bold font-['DM_Sans']">
                      {index + 1}. {company.name}
                    </div>

                    {company.score !== null && (
                      <div className="px-2.5 py-[5px] bg-violet-500/10 rounded-full text-violet-500 text-xs font-bold font-['DM_Sans']">
                        {Math.round(company.score)}% Match
                      </div>
                    )}
                  </div>

                  {company.score !== null && (
                    <div className="mt-3 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-violet-500 rounded-full"
                        style={{ width: `${company.score}%` }}
                      />
                    </div>
                  )}

                  {company.reason && (
                    <p className="mt-3 text-gray-600 text-xs font-normal font-['DM_Sans'] leading-5">
                      {company.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-xs font-['DM_Sans']">
              No company matches were saved for this analysis.
            </p>
          )}
        </div>

        {/* ========================= */}
        {/* KEYWORD / SKILL MATCH */}
        {/* ========================= */}

        <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md flex flex-col gap-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3.5">
              <div className="size-10 bg-violet-500/10 rounded-2xl outline outline-1 outline-violet-500/20 flex justify-center items-center">
                <Target className="size-5 text-violet-500" />
              </div>

              <div>
                <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                  Keyword and Skill Optimization
                </div>

                <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                  Mixed skills and keywords requested by your top five matched companies
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end">
              <div className="text-violet-500 text-2xl font-extrabold font-['DM_Sans']">
                {keywordCoverage}%
              </div>

              <div className="text-gray-400 text-[10px] font-bold font-['DM_Sans'] uppercase">
                Coverage
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {mixedTerms.length === 0 ? (
              <span className="text-gray-500 text-xs font-['DM_Sans']">
                No keywords or skills were saved.
              </span>
            ) : (
              mixedTerms.map((term) => (
                <div
                  key={term.skill}
                  className="p-5 bg-white/60 rounded-2xl outline outline-1 outline-white flex flex-col gap-2.5"
                >
                  <div className="flex justify-between items-center gap-3">
                    <div className="text-gray-900 text-sm font-bold font-['DM_Sans'] truncate">
                      {term.skill}
                    </div>

                    {term.missing ? (
                      <span className="shrink-0 px-2.5 py-[5px] bg-amber-100 rounded-full text-amber-600 text-xs font-bold font-['DM_Sans']">
                        Missing
                      </span>
                    ) : (
                      <span className="shrink-0 px-2.5 py-[5px] bg-emerald-50 rounded-full text-emerald-500 text-xs font-bold font-['DM_Sans']">
                        ✓ In resume
                      </span>
                    )}
                  </div>

                  {term.companies.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {term.companies.map((company) => (
                        <span
                          key={company}
                          className="px-2 py-[3px] bg-violet-500/10 rounded-full text-violet-600 text-[11px] font-semibold font-['DM_Sans']"
                        >
                          {company}
                        </span>
                      ))}
                    </div>
                  )}

                  {term.recommendation && (
                    <div className="text-gray-600 text-xs font-normal font-['DM_Sans'] leading-4">
                      {term.recommendation}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-3.5">
            <div className="w-28 text-gray-600 text-xs font-bold font-['DM_Sans']">
              Coverage
            </div>

            <div className="flex-1 h-2 bg-gray-200/50 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-violet-500 to-cyan-500 rounded-full"
                style={{
                  width: `${keywordCoverage}%`,
                }}
              />
            </div>

            <div className="w-11 text-right text-gray-900 text-xs font-extrabold font-['DM_Sans']">
              {keywordCoverage}%
            </div>
          </div>
        </div>

        {/* ========================= */}
        {/* FORMATTING */}
        {/* ========================= */}

        <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md flex flex-col gap-5">
          <div className="flex items-center gap-3.5">
            <div className="size-10 bg-cyan-500/10 rounded-2xl outline outline-1 outline-cyan-500/20 flex justify-center items-center">
              <FileText className="size-5 text-cyan-500" />
            </div>

            <div>
              <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                Formatting and Readability Checks
              </div>

              <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                Issues and observations captured from the saved analysis
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {grammarIssues.length > 0 ? (
              grammarIssues.map((issue, index) => {
                const title = isRecord(issue)
                  ? String(
                      issue.title ??
                        issue.type ??
                        issue.category ??
                        'Grammar / formatting issue'
                    )
                  : 'Grammar / formatting issue';

                const description = getDescription(issue);

                return (
                  <div
                    key={index}
                    className="p-3.5 bg-white/60 rounded-2xl outline outline-1 outline-white flex items-center gap-3.5"
                  >
                    <div className="size-9 bg-amber-100 rounded-[10px] flex justify-center items-center shrink-0">
                      <TriangleAlert className="size-4 text-amber-600" />
                    </div>

                    <div className="w-48 shrink-0">
                      <div className="text-gray-400 text-[10px] font-bold font-['DM_Sans'] uppercase">
                        Review
                      </div>

                      <div className="text-gray-900 text-sm font-bold font-['DM_Sans']">
                        {title}
                      </div>
                    </div>

                    <div className="flex-1 text-gray-600 text-xs font-normal font-['DM_Sans'] leading-5">
                      {description || textValue(issue)}
                    </div>

                    <div className="px-2.5 py-[5px] bg-amber-100 rounded-full text-amber-600 text-xs font-bold font-['DM_Sans']">
                      Review
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="p-4 bg-emerald-50/70 rounded-2xl flex items-center gap-3">
                <div className="size-9 bg-emerald-50 rounded-[10px] flex justify-center items-center">
                  <Check className="size-4 text-emerald-500" />
                </div>

                <div className="flex-1 text-gray-600 text-xs font-semibold font-['DM_Sans']">
                  No grammar or formatting issues were returned in the saved
                  analysis.
                </div>

                <div className="px-2.5 py-[5px] bg-emerald-50 rounded-full text-emerald-500 text-xs font-bold font-['DM_Sans']">
                  Passed
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ========================= */}
        {/* TOP JOBS */}
        {/* ========================= */}

        {(
          <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md">
            <div className="flex items-center gap-3.5 mb-5">
              <div className="size-10 bg-cyan-500/10 rounded-2xl outline outline-1 outline-cyan-500/20 flex justify-center items-center">
                <Target className="size-5 text-cyan-500" />
              </div>

              <div>
                <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                  Matching Job Openings
                </div>

                <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                  Job matches preserved from this analysis
                </div>
              </div>
            </div>

            {topJobs.length === 0 && (
              <p className="text-gray-500 text-xs font-['DM_Sans']">
                No matching job openings were saved for this analysis.
              </p>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              {topJobs.slice(0, 6).map((job, index) => {
                const title = String(
                  job.title ??
                    job.job_title ??
                    job.name ??
                    'Job opportunity'
                );

                const company = String(
                  job.company ??
                    job.company_name ??
                    job.employer ??
                    ''
                );

                const location = String(
                  job.location ??
                    job.job_location ??
                    ''
                );

                const match = getScore(job);

                const applyUrl = String(
                  job.apply_url ??
                    job.url ??
                    job.job_apply_link ??
                    ''
                );

                return (
                  <div
                    key={`${title}-${index}`}
                    className="p-5 bg-white/60 rounded-2xl outline outline-1 outline-white"
                  >
                    <div className="flex justify-between gap-4">
                      <div>
                        <div className="text-gray-900 text-sm font-bold font-['DM_Sans']">
                          {title}
                        </div>

                        {company && (
                          <div className="mt-1 text-gray-400 text-xs font-semibold font-['DM_Sans']">
                            {company}
                          </div>
                        )}

                        {location && (
                          <div className="mt-1 text-gray-600 text-xs font-normal font-['DM_Sans']">
                            {location}
                          </div>
                        )}
                      </div>

                      {match !== null && (
                        <div className="px-2.5 py-[5px] h-fit bg-violet-500/10 rounded-full text-violet-500 text-xs font-bold font-['DM_Sans']">
                          {match}%
                        </div>
                      )}
                    </div>

                    {applyUrl && (
                      <a
                        href={applyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex mt-4 text-violet-500 text-xs font-bold font-['DM_Sans'] hover:text-violet-700"
                      >
                        View job →
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* ========================= */}
        {/* CERTIFICATIONS */}
        {/* ========================= */}

        <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md flex flex-col gap-6">
          <div className="flex items-center gap-3.5">
            <div className="size-10 bg-violet-500/10 rounded-2xl outline outline-1 outline-violet-500/20 flex justify-center items-center">
              <Sparkles className="size-5 text-violet-500" />
            </div>

            <div>
              <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                Certification Recommendations
              </div>

              <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                Suggestions preserved from this saved analysis
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5">
            <div className="p-5 bg-white/60 rounded-2xl outline outline-1 outline-white flex flex-col gap-3.5">
              {certifications.length > 0 ? (
                certifications.map((certification, index) => {
                  const name =
                    String(
                      certification.full_name ??
                        certification.name ??
                        certification.title ??
                        'Certification'
                    );

                  const provider = String(
                    certification.provider ??
                      certification.issuer ??
                      ''
                  );

                  const url = String(
                    certification.url ??
                      certification.link ??
                      ''
                  );

                  return (
                    <div
                      key={`${name}-${index}`}
                      className="flex items-start gap-3"
                    >
                      <div className="size-8 bg-cyan-500/10 rounded-[10px] flex justify-center items-center shrink-0">
                        <ShieldCheck className="size-4 text-cyan-500" />
                      </div>

                      <div className="flex-1 flex flex-col gap-0.5">
                        <div className="flex justify-between items-center gap-2">
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-gray-900 text-xs font-bold font-['DM_Sans'] hover:text-violet-500 transition"
                            >
                              {name}
                            </a>
                          ) : (
                            <div className="text-gray-900 text-xs font-bold font-['DM_Sans']">
                              {name}
                            </div>
                          )}

                          <div className="px-2.5 py-[5px] bg-amber-100 rounded-full text-amber-600 text-xs font-bold font-['DM_Sans']">
                            Recommended
                          </div>
                        </div>

                        {provider && (
                          <div className="text-gray-400 text-xs font-semibold font-['DM_Sans']">
                            {provider}
                          </div>
                        )}

                        <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                          Certification relevant to {targetJob}.
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-gray-500 text-xs font-['DM_Sans']">
                  No certification recommendations were saved for this
                  analysis.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ========================= */}
        {/* STRENGTHS / IMPROVEMENTS */}
        {/* ========================= */}

        <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md flex flex-col gap-6">
          <div className="flex items-center gap-3.5">
            <div className="size-10 bg-amber-100 rounded-2xl outline outline-1 outline-amber-600/20 flex justify-center items-center">
              <Lightbulb className="size-5 text-amber-600" />
            </div>

            <div>
              <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                Key Strengths and Priority Improvements
              </div>

              <div className="text-gray-600 text-xs font-normal font-['DM_Sans']">
                The observations captured with this analysis
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            {/* Strengths */}

            <div className="p-5 bg-white/60 rounded-2xl outline outline-1 outline-white flex flex-col gap-4">
              <div className="flex items-center gap-2.5">
                <div className="size-7 bg-emerald-50 rounded-full flex justify-center items-center">
                  <div className="text-emerald-500 text-xs font-extrabold font-['DM_Sans']">
                    {strengths.length}
                  </div>
                </div>

                <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                  Key Strengths
                </div>
              </div>

              {strengths.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {strengths.map((strength, index) => (
                    <div
                      key={`${strength}-${index}`}
                      className="flex items-start gap-2.5"
                    >
                      <Check className="size-4 mt-0.5 text-emerald-500 shrink-0" />

                      <div className="flex-1 text-gray-600 text-xs font-normal font-['DM_Sans'] leading-5">
                        {strength}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-xs font-['DM_Sans']">
                  No saved strengths were returned for this analysis.
                </p>
              )}
            </div>

            {/* Improvements */}

            <div className="p-5 bg-white/60 rounded-2xl outline outline-1 outline-white flex flex-col gap-4">
              <div className="flex items-center gap-2.5">
                <div className="size-7 bg-amber-100 rounded-full flex justify-center items-center">
                  <div className="text-amber-600 text-xs font-extrabold font-['DM_Sans']">
                    {improvements.length}
                  </div>
                </div>

                <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
                  Priority Improvements
                </div>
              </div>

              {improvements.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {improvements.map((improvement, index) => (
                    <div
                      key={`${improvement}-${index}`}
                      className="flex items-start gap-2.5"
                    >
                      <TriangleAlert className="size-4 mt-0.5 text-amber-600 shrink-0" />

                      <div className="flex-1 text-gray-600 text-xs font-normal font-['DM_Sans'] leading-5">
                        {improvement}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-xs font-['DM_Sans']">
                  No saved improvements were returned for this analysis.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ========================= */}
        {/* FEEDBACK REPORT SUMMARY */}
        {/* ========================= */}

        <div className="mt-6 p-7 bg-white/80 rounded-[20px] shadow-[0px_12px_34px_0px_rgba(17,24,39,0.04)] outline outline-[1.5px] outline-white backdrop-blur-md">
          <div className="flex items-center gap-3.5 mb-4">
            <div className="size-10 bg-violet-500/10 rounded-2xl outline outline-1 outline-violet-500/20 flex justify-center items-center">
              <FileText className="size-5 text-violet-500" />
            </div>

            <div className="text-gray-900 text-lg font-bold font-['DM_Sans']">
              Feedback Report Summary
            </div>
          </div>

          <p className="text-gray-600 text-sm font-normal font-['DM_Sans'] leading-6">
            {feedbackSummary}
          </p>
        </div>

      </main>
    </div>
  );
}