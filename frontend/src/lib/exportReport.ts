import { jsPDF } from 'jspdf';
import type { AnalysisResult } from '@/types/analysis';

export interface SupabaseUser {
  id?: string;
  email?: string | null;
  full_name?: string | null;
  created_at?: string;
  // Included to handle raw Supabase Auth user objects seamlessly
  user_metadata?: {
    full_name?: string;
    name?: string;
    [key: string]: unknown;
  };
}

// Fields the PDF reads beyond the ones already used. All optional, so the file
// compiles even if AnalysisResult doesn't declare them yet. Rename to match
// your real AnalysisResult keys if they differ.
type ExtendedResult = AnalysisResult & {
  grammar_issues?: { type: string; text: string }[];
  certifications?: { name: string; provider: string; reason: string; relevance: string }[];
  top_companies?: { company: string; score?: number; total_score?: number }[];
  summary?: string;
  feedback_summary?: string;
};

// ─────────────────────────────────────────────
// Layout & Color System (A4 in points)
// ─────────────────────────────────────────────
const MARGIN = 40;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = PAGE_HEIGHT - 50;

const COLOR = {
  primary: [79, 70, 229] as [number, number, number],       // Indigo #4F46E5
  primaryDark: [49, 46, 129] as [number, number, number],   // Dark Indigo #312E81
  slate900: [15, 23, 42] as [number, number, number],       // Slate 900
  slate700: [51, 65, 85] as [number, number, number],       // Slate 700
  slate500: [100, 116, 139] as [number, number, number],    // Slate 500
  slate200: [226, 232, 240] as [number, number, number],    // Slate 200
  slate50: [248, 250, 252] as [number, number, number],     // Slate 50
  emerald: [16, 185, 129] as [number, number, number],      // Green #10B981
  amber: [245, 158, 11] as [number, number, number],        // Amber #F59E0B
  rose: [244, 63, 94] as [number, number, number],          // Rose #F43F5E
  white: [255, 255, 255] as [number, number, number],
};

// Spam-click guard shared by every Export PDF button: a second export within
// this window is ignored, so mashing the button downloads only one file.
const EXPORT_COOLDOWN_MS = 1000;
let lastExportAt = 0;

// Backend scores may be 0-1 or 0-100; always print a 0-100 percentage.
const toPercent = (n: number | undefined) => {
  const v = Number.isFinite(n) ? (n as number) : 0;
  return Math.round(Math.min(100, Math.max(0, v <= 1 ? v * 100 : v)));
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Shared export sequence. Do NOT call this (or generateReportPDF) directly from a
 * button: use the `useExportPdf` hook so every Export PDF button behaves the same:
 *   1. the button shows its loading state first (EXPORT_LOADING_MS),
 *   2. THEN the PDF downloads and the loading state ends,
 *   3. the button stays disabled, without a spinner, for EXPORT_AFTER_MS so it
 *      can't be spam-clicked (that cooldown is handled by the hook).
 */
export const EXPORT_LOADING_MS = 800;
export const EXPORT_AFTER_MS = 1200;

export async function exportReportWithLoading(
  result: AnalysisResult,
  user?: SupabaseUser | null,
  customFileName?: string
): Promise<void> {
  await wait(EXPORT_LOADING_MS);
  generateReportPDF(result, user, customFileName);
  // The post-download cooldown (EXPORT_AFTER_MS) now lives in useExportPdf, so
  // the spinner stops at the same moment the file downloads.
}

// Longest slice of the display name used in the downloaded file's name.
const FILE_NAME_SLUG_MAX = 40;

// Shortens text with "..." so it fits in maxWidth points (uses the current font).
function fitText(doc: jsPDF, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && doc.getTextWidth(`${text.slice(0, end)}...`) > maxWidth) end -= 1;
  return `${text.slice(0, end)}...`;
}

/**
 * Builds and downloads an executive-grade PDF analysis report.
 */
export function generateReportPDF(
  result: AnalysisResult,
  user?: SupabaseUser | null,
  customFileName?: string
): void {
  const now = Date.now();
  if (now - lastExportAt < EXPORT_COOLDOWN_MS) return;
  lastExportAt = now;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = MARGIN;

  // ── Extract User Information safely across DB & Auth structures ──
  const rawName =
    user?.full_name?.trim() ||
    user?.user_metadata?.full_name?.trim() ||
    user?.user_metadata?.name?.trim() ||
    '';

  const candidateName = rawName || (user?.email ? user.email.split('@')[0] : 'Valued Candidate');
  const candidateEmail = user?.email || 'N/A';

  // ── Format Dynamic Filename: name-aura-resume_report.pdf ───────
  const nameSlug = rawName
    ? rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : user?.email
    ? user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : 'user';

  const shortSlug = nameSlug.slice(0, FILE_NAME_SLUG_MAX).replace(/-+$/g, '') || 'user';
  const fileName = customFileName || `${shortSlug}-aura-resume_report.pdf`;

  // ── Helper: Page Overflow Guard ───────────────────────
  const ensureSpace = (needed: number) => {
    if (y + needed > BOTTOM_LIMIT) {
      doc.addPage();
      y = MARGIN + 20;
    }
  };

  // ── Helper: Section Heading with Accent Bar ───────────
  const renderSectionHeader = (title: string) => {
    ensureSpace(35);
    doc.setFillColor(...COLOR.primary);
    doc.rect(MARGIN, y, 4, 14, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...COLOR.slate900);
    doc.text(title.toUpperCase(), MARGIN + 12, y + 11);
    y += 24;
  };

  // ── 1. Top Decorative Brand Banner ────────────────────
  doc.setFillColor(...COLOR.primaryDark);
  doc.rect(0, 0, PAGE_WIDTH, 8, 'F');

  // ── 2. Report Header Block ────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...COLOR.primaryDark);
  doc.text('ARIA RESUME ANALYSIS', MARGIN, y + 20);

  // User details block (Top Right)
  const reportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  // The title takes the left ~270pt; the name/email are cut with "..." to fit the rest.
  const detailsMaxWidth = CONTENT_WIDTH - 280;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.slate900);
  doc.text(fitText(doc, candidateName, detailsMaxWidth), PAGE_WIDTH - MARGIN, y + 8, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...COLOR.slate500);
  doc.text(fitText(doc, candidateEmail, detailsMaxWidth), PAGE_WIDTH - MARGIN, y + 20, { align: 'right' });
  doc.text(`Generated: ${reportDate}`, PAGE_WIDTH - MARGIN, y + 31, { align: 'right' });

  y += 48;

  // Divider
  doc.setDrawColor(...COLOR.slate200);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 18;

  const r = result as ExtendedResult;

  const scoreColorOf = (v: number) => (v >= 80 ? COLOR.emerald : v >= 60 ? COLOR.amber : COLOR.rose);

  const bulletList = (items: string[], color: [number, number, number], empty: string) => {
    if (items.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.slate500);
      doc.text(empty, MARGIN, y);
      y += 16;
      return;
    }
    items.forEach((item) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.slate700);
      const lines = doc.splitTextToSize(item, CONTENT_WIDTH - 20);
      ensureSpace(lines.length * 13 + 4);
      doc.setFillColor(...color);
      doc.circle(MARGIN + 4, y - 3, 2.5, 'F');
      doc.text(lines, MARGIN + 16, y);
      y += lines.length * 13 + 4;
    });
  };

  const emptyNote = (text: string) => {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9.5);
    doc.setTextColor(...COLOR.slate500);
    doc.text(text, MARGIN, y);
    y += 16;
  };

  const badge = (label: string, x: number, yy: number, bg: [number, number, number], w = 80) => {
    doc.setFillColor(...bg);
    doc.roundedRect(x, yy - 8, w, 11, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...COLOR.white);
    doc.text(label, x + w / 2, yy - 1, { align: 'center' });
  };

  // ── 3. ATS Score ──────────────────────────────────────
  const score = result.ats_score ?? 0;
  renderSectionHeader('ATS Score');
  ensureSpace(90);
  const cardHeight = 70;
  doc.setFillColor(...COLOR.slate50);
  doc.setDrawColor(...COLOR.slate200);
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, cardHeight, 6, 6, 'FD');
  doc.setFillColor(...scoreColorOf(score));
  doc.roundedRect(MARGIN + 12, y + 10, 70, 50, 4, 4, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...COLOR.white);
  doc.text(`${score}%`, MARGIN + 47, y + 38, { align: 'center' });
  doc.setFontSize(7);
  doc.text('ATS SCORE', MARGIN + 47, y + 51, { align: 'center' });

  const band = score >= 80 ? 'Strong' : score >= 60 ? 'Fair, room to improve' : 'Needs significant work';
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.slate900);
  doc.text(band, MARGIN + 100, y + 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...COLOR.slate500);
  doc.text('How well your resume can be read and ranked by applicant tracking systems.', MARGIN + 100, y + 44);
  y += cardHeight + 20;

  // ── 4. Dimension Analysis ─────────────────────────────
  renderSectionHeader('Dimension Analysis');
  if (!result.sections || result.sections.length === 0) {
    emptyNote('No dimension scores available.');
  } else {
    const barX = MARGIN + 150;
    const barW = CONTENT_WIDTH - 150 - 40;
    result.sections.forEach((sec) => {
      ensureSpace(20);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.slate700);
      doc.text(fitText(doc, sec.name, 140), MARGIN, y);
      doc.setFillColor(...COLOR.slate200);
      doc.roundedRect(barX, y - 8, barW, 8, 4, 4, 'F');
      const v = Math.max(0, Math.min(100, sec.value));
      if (v > 0) {
        doc.setFillColor(...scoreColorOf(v));
        doc.roundedRect(barX, y - 8, Math.max(8, (barW * v) / 100), 8, 4, 4, 'F');
      }
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLOR.slate900);
      doc.text(`${v}%`, PAGE_WIDTH - MARGIN, y, { align: 'right' });
      y += 20;
    });
  }
  y += 10;

  // ── 5. Top Company Matches ────────────────────────────
  renderSectionHeader('Top Company Matches');
  let companies: { company: string; score: number }[] = [];
  if (result.companies && result.companies.length > 0) {
    companies = result.companies.map((c) => ({ company: c.company, score: toPercent(c.match) }));
  } else if (r.top_companies && r.top_companies.length > 0) {
    companies = r.top_companies.map((c) => ({ company: c.company, score: toPercent(c.score ?? c.total_score) }));
  } else {
    // Fallback: best job score per company
    const best = new Map<string, number>();
    (result.top_jobs ?? []).forEach((j) => {
      best.set(j.company, Math.max(best.get(j.company) ?? 0, toPercent(j.total_score)));
    });
    companies = [...best.entries()].map(([company, s]) => ({ company, score: s }));
  }
  companies.sort((a, b) => b.score - a.score);
  if (companies.length === 0) {
    emptyNote('No company matches found.');
  } else {
    companies.slice(0, 5).forEach((c, i) => {
      ensureSpace(20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.slate900);
      doc.text(`${i + 1}. ${fitText(doc, c.company, CONTENT_WIDTH - 90)}`, MARGIN, y);
      doc.setTextColor(...COLOR.primary);
      doc.text(`${c.score}% Match`, PAGE_WIDTH - MARGIN, y, { align: 'right' });
      y += 18;
    });
  }
  y += 10;

  // ── 6. Keyword and Skill Optimization ─────────────────
  renderSectionHeader('Keyword and Skill Optimization');
  const keywordItems = result.keyword_gaps?.length ? result.keyword_gaps : result.skill_gaps ?? [];
  if (keywordItems.length === 0) {
    emptyNote('No keywords or skills to show.');
  } else {
    keywordItems.forEach((gap) => {
      const isMissing = gap.missing;
      const recLines = doc.splitTextToSize(gap.recommendation, CONTENT_WIDTH - 12);
      ensureSpace(recLines.length * 12 + 22);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...COLOR.slate900);
      doc.text(gap.skill, MARGIN, y);
      const w = doc.getTextWidth(gap.skill);
      badge(isMissing ? 'MISSING' : 'IN RESUME', MARGIN + w + 8, y, isMissing ? COLOR.rose : COLOR.emerald, 60);
      y += 13;

      const sources = (gap as { source_companies?: string[] }).source_companies;
      if (sources?.length) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...COLOR.primary);
        doc.text(fitText(doc, `Requested by: ${sources.join(', ')}`, CONTENT_WIDTH), MARGIN, y);
        y += 11;
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.slate500);
      doc.text(recLines, MARGIN, y);
      y += recLines.length * 12 + 6;
    });
  }
  y += 10;

  // ── 7. Formatting and Readability Checks ──────────────
  renderSectionHeader('Formatting and Readability Checks');
  if (!r.grammar_issues || r.grammar_issues.length === 0) {
    emptyNote('No formatting or readability issues found.');
  } else {
    r.grammar_issues.forEach((issue) => {
      const lines = doc.splitTextToSize(issue.text, CONTENT_WIDTH - 95);
      ensureSpace(lines.length * 12 + 8);
      badge(issue.type.toUpperCase().slice(0, 16), MARGIN, y, COLOR.primary, 80);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...COLOR.slate700);
      doc.text(lines, MARGIN + 90, y);
      y += lines.length * 12 + 6;
    });
  }
  y += 10;

  // ── 8. Matching Job Openings ──────────────────────────
  renderSectionHeader('Matching Job Openings');
  if (!result.top_jobs || result.top_jobs.length === 0) {
    emptyNote('No matching job openings found.');
  } else {
    result.top_jobs.slice(0, 5).forEach((job) => {
      ensureSpace(28);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLOR.slate900);
      doc.text(fitText(doc, job.title, CONTENT_WIDTH - 90), MARGIN, y);
      doc.setFontSize(9);
      doc.setTextColor(...COLOR.primary);
      doc.text(`${toPercent(job.total_score)}% Match`, PAGE_WIDTH - MARGIN, y, { align: 'right' });
      y += 11;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.slate500);
      doc.text(`${job.company} • ${job.location}`, MARGIN, y);
      y += 16;
    });
  }
  y += 10;

  // ── 9. Certification Recommendations ──────────────────
  renderSectionHeader('Certification Recommendations');
  if (!r.certifications || r.certifications.length === 0) {
    emptyNote('No certification recommendations.');
  } else {
    r.certifications.forEach((cert) => {
      const required = cert.relevance.trim().toLowerCase() === 'required';
      const lines = doc.splitTextToSize(cert.reason, CONTENT_WIDTH - 12);
      ensureSpace(lines.length * 12 + 34);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...COLOR.slate900);
      doc.text(fitText(doc, cert.name, CONTENT_WIDTH - 90), MARGIN, y);
      badge(required ? 'REQUIRED' : 'OPTIONAL', PAGE_WIDTH - MARGIN - 60, y, required ? COLOR.rose : COLOR.amber, 60);
      y += 12;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.primary);
      doc.text(cert.provider, MARGIN, y);
      y += 12;
      doc.setTextColor(...COLOR.slate500);
      doc.text(lines, MARGIN, y);
      y += lines.length * 12 + 6;
    });
  }
  y += 10;

  // ── 10. Key Strengths ─────────────────────────────────
  renderSectionHeader('Key Strengths');
  bulletList(result.strengths ?? [], COLOR.emerald, 'No key strengths found yet.');
  y += 10;

  // ── 11. Smart Suggestions ─────────────────────────────
  renderSectionHeader('Smart Suggestions');
  bulletList(result.improvements ?? [], COLOR.amber, 'No suggestions right now.');
  y += 10;

  // ── 12. Feedback Report Summary ───────────────────────
  renderSectionHeader('Feedback Report Summary');
  const written = r.summary || r.feedback_summary;
  const missingCount = (result.keyword_gaps?.length ? result.keyword_gaps : result.skill_gaps ?? []).filter((g) => g.missing).length;
  const generated =
    `Your resume scored ${score}% on ATS compatibility. ` +
    `${(result.strengths ?? []).length} key strength(s) and ${(result.improvements ?? []).length} suggestion(s) were identified` +
    (missingCount ? `, with ${missingCount} keyword/skill gap(s) to close` : '') +
    (companies[0] ? `. Your strongest company match is ${companies[0].company} at ${companies[0].score}%.` : '.');
  const summaryLines = doc.splitTextToSize(written || generated, CONTENT_WIDTH);
  ensureSpace(summaryLines.length * 13 + 4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...COLOR.slate700);
  doc.text(summaryLines, MARGIN, y);
  y += summaryLines.length * 13 + 4;

  // ── 8. Global Dynamic Header & Footer Pass ────────────
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);

    doc.setDrawColor(...COLOR.slate200);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, PAGE_HEIGHT - 35, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 35);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.slate500);
    doc.text('AURA — AI Resume Analyzer — Confidential Report', MARGIN, PAGE_HEIGHT - 22);
    doc.text(`Page ${i} of ${totalPages}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 22, {
      align: 'right',
    });
  }

  doc.save(fileName);
}