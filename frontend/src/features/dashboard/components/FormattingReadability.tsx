// src/components/FormattingReadability.tsx

'use client';

import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { FileText } from 'lucide-react';

// ADDED: hover lift for buttons (no lift while disabled, respects reduced motion).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 disabled:hover:translate-y-0';

// Represents a single grammar/style issue with its category and description
type GrammarIssue = {
  type: string;
  text: string;
};

type FormattingReadabilityProps = {
  grammarIssues: GrammarIssue[];
};

// Issues shown per page (as in the Figma design)
const PAGE_SIZE = 4;

// Badge + row colors per issue category.
// Matched by category name, case-insensitively; any other category uses the neutral style.
// `row` is a soft tint for the whole issue box (kept light so it isn't too bright).
type IssueStyle = { badge: string; row: string };

// Shared row tints. They match the old status-dot colors: red for structural
// issues, yellow for consistency and language issues.
const ROW_RED = 'border-[#fca5a5]/60 bg-[#fee2e2]/70';
const ROW_YELLOW = 'border-[#fde047]/50 bg-[#fef9c3]/80';

// NOTE: these keys must match the actual `type` strings resume_enricher.py's
// _check_grammar() produces (see its GRAMMAR_CHECKS list and the individual
// _check_* helpers) — not a generic guess. The real set is: Passive, Tense,
// Clarity, Brevity, Content, Formatting, Consistency, Readability,
// Sentence Length, Contact, Section Order, Bullet Count, Impact,
// Tense Consistency, Variety, Spelling, Style. Previously this map only
// covered formatting/structure/readability/consistency, so ~12 of the 17
// real categories silently fell through to the neutral grey style.
const ISSUE_STYLES: Record<string, IssueStyle> = {
  // Structural / visual-layout issues (blue badge, soft red box)
  formatting: { badge: 'bg-[#dbeafe] text-[#2563eb]', row: ROW_RED },
  content: { badge: 'bg-[#dbeafe] text-[#2563eb]', row: ROW_RED },
  contact: { badge: 'bg-[#dbeafe] text-[#2563eb]', row: ROW_RED },
  'section order': { badge: 'bg-[#dbeafe] text-[#2563eb]', row: ROW_RED },
  'bullet count': { badge: 'bg-[#dbeafe] text-[#2563eb]', row: ROW_RED },

  // Consistency issues (yellow badge, soft yellow box)
  consistency: { badge: 'bg-[#fef9c3] text-[#a16207]', row: ROW_YELLOW },
  'tense consistency': { badge: 'bg-[#fef9c3] text-[#a16207]', row: ROW_YELLOW },

  // Linguistic clarity / readability issues (purple badge, soft yellow box)
  readability: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  clarity: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  brevity: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  passive: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  tense: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  'sentence length': { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  variety: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  spelling: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  impact: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
  style: { badge: 'bg-[#ede9fe] text-[#7c3aed]', row: ROW_YELLOW },
};

const NEUTRAL_STYLE: IssueStyle = {
  badge: 'bg-[#f3f4f6] text-[#4b5563]',
  row: 'border-[#e5e7eb] bg-[#f3f4f6]/70',
};

const getIssueStyle = (type: string): IssueStyle =>
  ISSUE_STYLES[type.trim().toLowerCase()] ?? NEUTRAL_STYLE;

// Card component displaying a paginated list of formatting and readability issues
export default function FormattingReadability({ grammarIssues }: FormattingReadabilityProps) {
  const [page, setPage] = useState(0);
  // ADDED: respect the OS "reduce motion" setting
  const reduceMotion = useReducedMotion();

  const total = grammarIssues.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp in case the list shrinks while a later page is open
  const currentPage = Math.min(page, totalPages - 1);

  const startIndex = currentPage * PAGE_SIZE;
  const visible = grammarIssues.slice(startIndex, startIndex + PAGE_SIZE);
  const isFirstPage = currentPage === 0;
  const isLastPage = currentPage >= totalPages - 1;

  return (
    <section className="flex flex-col gap-6 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px] sm:p-8">
      {/* Header */}
      <div className="flex items-center gap-[14px]">
        <div className="flex shrink-0 items-center justify-center rounded-[12px] border border-[#06b6d4]/20 bg-[#06b6d4]/10 p-[10px]">
          <FileText className="size-5 text-[#06b6d4]" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-[18px] font-bold leading-tight text-[#111827]">
            Formatting and Readability Checks
          </h3>
          <p className="text-[13px] text-[#4b5563]">
            Checking the visual flow and layout for clarity
          </p>
        </div>
      </div>

      {/* Issues list - renders each grammar/style issue as a row */}
      {total === 0 ? (
        <p className="text-[13px] text-[#4b5563]">No formatting or readability issues found.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((issue, i) => {
            const style = getIssueStyle(issue.type);

            return (
              // CHANGED: plain <div> -> <motion.div>. Each row fades/slides up with a small
              // stagger. The key includes startIndex, so this replays on every page change.
              <motion.div
                key={`${issue.text}-${startIndex + i}`}
                initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: reduceMotion ? 0 : i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[16px] border-[1.5px] p-4 transition-shadow hover:shadow-[0_4px_12px_rgba(17,24,39,0.05)] ${style.row}`}
              >
                {/* Issue category/type label */}
                <span
                  className={`shrink-0 rounded-full px-[10px] py-1 text-[10px] font-extrabold uppercase leading-none ${style.badge}`}
                >
                  {issue.type}
                </span>

                {/* Issue description */}
                <p className="min-w-0 flex-1 basis-[200px] text-[13px] font-medium text-[#111827]">
                  {issue.text}
                </p>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Pagination (only when there is more than one page) */}
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-[#4b5563]">
            Showing {startIndex + 1}-{startIndex + visible.length} of {total} issues
          </p>

          <div className="flex items-center gap-[10px] font-medium">
            {/* CHANGED: `transition` -> BTN_MOTION (hover lift) on both buttons */}
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={isFirstPage}
              className={`flex items-center gap-[6px] rounded-[10px] border border-[#e5e7eb] bg-white/[0.72] px-4 py-2 text-[#4b5563] ${BTN_MOTION} hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white/[0.72]`}
            >
              <span className="text-[14px]">←</span>
              <span className="text-[13px]">Previous</span>
            </button>

            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={isLastPage}
              className={`flex items-center gap-[6px] rounded-[10px] bg-[#8b5cf6] px-4 py-2 text-white shadow-[0_4px_12px_rgba(124,58,237,0.2)] ${BTN_MOTION} hover:bg-[#7c3aed] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#8b5cf6]`}
            >
              <span className="text-[13px]">Next</span>
              <span className="text-[14px]">→</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}