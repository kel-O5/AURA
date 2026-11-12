// src/features/dashboard/components/AssessmentSidebar.tsx

'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Lightbulb, X } from 'lucide-react';

// `value` is null until a resume has been analyzed.
interface SectionData {
  name: string;
  value: number | null;
}

interface AssessmentSidebarProps {
  // null = no resume analyzed yet -> the card shows its empty state
  score: number | null;
  sections?: SectionData[];
}

// Dimensions listed (with "-" values) before any resume has been analyzed.
// NOTE: names must match what the backend actually returns in
// `sections` (resume_enricher.py's enrich_resume_local) — Keywords,
// Format, Skills, Impact, Length — not the earlier Figma copy
// (Formatting/Quantification/Readability), or lookups below silently
// fail for 3 of the 5 dimensions.
const EMPTY_SECTIONS: SectionData[] = [
  'Keywords',
  'Format',
  'Skills',
  'Impact',
  'Length',
].map((name) => ({ name, value: null }));

// Weight (in %) each dimension contributes to the ATS score. Must mirror
// resume_enricher.py's enrich_resume_local() weighting exactly:
//   Keywords 25% / Format 20% / Skills 25% / Impact 20% / Length 10%
// Matched by dimension name (case-insensitive); any other name shows "—"
// in the modal.
const DIMENSION_WEIGHTS: Record<string, number> = {
  keywords: 25,
  format: 20,
  skills: 25,
  impact: 20,
  length: 10,
};

// Copy for the "How Dimensions Are Measured" modal.
// Matched by dimension name (case-insensitive); unknown names show no description.
const DIMENSION_DESCRIPTIONS: Record<string, string> = {
  keywords:
    'Evaluates relevance and density of industry-specific terms, skills, and job-title matches against your matched job postings.',
  format:
    'Measures resume structure, section organization, bullet consistency, and ATS-parseable formatting.',
  skills:
    'Checks how many recognized skills appear in your Skills section, and how well they cover common recruiter/ATS skill categories.',
  impact:
    'Assesses action verbs, accomplishment framing, and quantified, value-driven language.',
  length:
    'Checks whether your total word count falls in the optimal 400–800 word range for readability and ATS parsing.',
};

// A dimension scoring below this "meets" line gets a short "how to improve" tip
// under its bar. Same cut-off getScoreSummary() uses for "Strong".
const MEETS_SCORE = 70;

// Improvement tips shown under a below-threshold dimension.
// Matched by dimension name (case-insensitive); unknown names show no tip.
const DIMENSION_TIPS: Record<string, string> = {
  keywords:
    'Reuse the exact skill and job-title wording from postings you are targeting, and work each key term into your experience bullets, not only the Skills list.',
  format:
    'Use standard headings (Summary, Experience, Skills, Education) and one bullet style, and avoid tables, columns, text boxes, or images that ATS parsers can misread.',
  skills:
    'Add more of the core tools and technologies for your target role to a dedicated Skills section, grouped by category (languages, frameworks, tools).',
  impact:
    'Start each bullet with a strong action verb and add numbers to show results, e.g. "reduced load time by 35%" or "served 200+ users".',
  length:
    'Aim for roughly 400–800 words: add specific accomplishments if the resume is short, or trim older and repetitive details if it is long.',
};

const normalize = (name: string) => name.trim().toLowerCase();
const getWeight = (name: string): number | undefined => DIMENSION_WEIGHTS[normalize(name)];
const getDescription = (name: string): string | undefined => DIMENSION_DESCRIPTIONS[normalize(name)];
const getTip = (name: string): string | undefined => DIMENSION_TIPS[normalize(name)];

const clampPercent = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));

// 18 -> "18.0", 18.75 -> "18.75", 10.2 -> "10.2"
function formatPoints(n: number) {
  const s = n.toFixed(2).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

// Score-dependent summary line for the Overall Assessment card.
// Previously this was a single hardcoded string regardless of score
// ("Resume complexity is Optimal for Executive-level parsing.") — now
// it actually reflects the number in the ring.
function getScoreSummary(score: number): string {
  if (score >= 85) return 'Excellent — this resume is well optimized for ATS and recruiter screening.';
  if (score >= 70) return 'Strong — a few targeted improvements would push this into top-tier range.';
  if (score >= 50) return 'Needs work — several dimensions below are holding this score back.';
  return 'Needs significant improvement across most dimensions below.';
}

// Shared frosted card shell used by both sidebar cards.
const CARD_CLASS =
  'flex flex-col gap-5 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px] sm:p-7';

// Small "i" button next to the card titles; opens the matching explanation modal.
function InfoButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[#4b5563]/25 bg-[#4b5563]/10 text-[13px] font-bold leading-none text-[#4b5563] transition hover:border-[#7c3aed]/40 hover:bg-[#7c3aed]/15 hover:text-[#7c3aed]"
    >
      i
    </button>
  );
}

// Circular progress ring showing the overall score percentage.
// With no score yet it shows a dash and "No score yet" instead of the ring.
// CHANGED: the filled arc now draws itself from empty to the score (motion.circle).
function ScoreChart({ score, label = 'ATS Score' }: { score: number | null; label?: string }) {
  const gradientId = `score-ring-${useId().replace(/:/g, '')}`;
  const reduceMotion = useReducedMotion();

  if (score === null) {
    return (
      <div className="flex h-[160px] w-full flex-col items-center justify-center gap-1">
        <span className="text-[28px] font-bold leading-none text-[#9ca3af]">-</span>
        <span className="text-[10px] font-bold uppercase text-[#4b5563]">No score yet</span>
      </div>
    );
  }

  const size = 130;
  const stroke = 12;
  const radius = (size - stroke) / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clampPercent(score) / 100);

  return (
    <div className="relative flex h-[160px] w-full items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
        </defs>

        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(124,58,237,0.10)"
          strokeWidth={stroke}
        />

        {/* Filled portion */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={reduceMotion ? false : { strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: reduceMotion ? 0 : 1.1, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>

      {/* Score percentage and label centered inside the ring */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-[2px]">
        <span className="text-[32px] font-extrabold leading-none text-[#111827]">{score}%</span>
        <span className="text-[10px] font-bold uppercase text-[#4b5563]">{label}</span>
      </div>
    </div>
  );
}

// One "Formatting ▬▬▬▬ 90%" row in the Dimension Analysis card.
// With no value yet it shows just the name and a dash.
// CHANGED: the bar grows from 0 to its value; `index` staggers the rows.
function DimensionRow({
  name,
  value,
  index = 0,
}: {
  name: string;
  value: number | null;
  index?: number;
}) {
  const reduceMotion = useReducedMotion();

  if (value === null) {
    return (
      <div className="flex h-8 items-center justify-between gap-3">
        <p className="text-[14px] font-semibold text-[#111827]">{name}</p>
        <p className="w-[38px] shrink-0 text-right text-[13px] font-bold text-[#9ca3af]">-</p>
      </div>
    );
  }

  const pct = clampPercent(value);

  return (
    <div className="flex h-8 items-center gap-3">
      <p
        title={name}
        className="w-[100px] shrink-0 truncate text-[14px] font-semibold text-[#111827]"
      >
        {name}
      </p>

      <div className="h-2 min-w-0 flex-1 rounded-full bg-[#7c3aed]/[0.08]">
        <motion.div
          className="h-full rounded-full bg-[linear-gradient(90deg,#8b5cf6_0%,#06b6d4_100%)]"
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{
            duration: reduceMotion ? 0 : 0.8,
            delay: reduceMotion ? 0 : 0.3 + index * 0.08,
            ease: [0.22, 1, 0.36, 1],
          }}
        />
      </div>

      <p className="w-[38px] shrink-0 text-right text-[13px] font-bold text-[#111827]">
        {Math.round(pct)}%
      </p>
    </div>
  );
}

// Collapsed "how to improve" note for a dimension below MEETS_SCORE. It only
// opens when the lightbulb button next to the score is clicked, so the score
// list keeps its normal layout until the user asks for the tip.
function DimensionTip({ id, text }: { id: string; text: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      id={id}
      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      <p className="mt-1.5 rounded-[10px] border border-[#a16207]/20 bg-[#fef9c3]/70 px-3 py-2 text-[12px] leading-[1.4] text-[#a16207]">
        <span className="font-bold">How to improve: </span>
        {text}
      </p>
    </motion.div>
  );
}

// One dimension: the normal score row, plus (after analysis) a fixed-width slot on
// the right. Rows below MEETS_SCORE put a lightbulb button in that slot; the other
// rows leave it empty, so every bar stays the same length and lined up.
function DimensionItem({
  name,
  value,
  index,
  tip,
  showSlot,
}: {
  name: string;
  value: number | null;
  index: number;
  tip?: string;
  showSlot: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <DimensionRow name={name} value={value} index={index} />
        </div>

        {showSlot && (
          <div className="flex size-6 shrink-0 items-center justify-center">
            {tip && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={tipId}
                aria-label={`${open ? 'Hide' : 'Show'} how to improve ${name}`}
                title="How to improve"
                className={`flex size-6 items-center justify-center rounded-full border border-[#a16207]/25 text-[#a16207] transition hover:bg-[#fde68a] ${
                  open ? 'bg-[#fde68a] ring-2 ring-[#a16207]/20' : 'bg-[#fef9c3]'
                }`}
              >
                <Lightbulb className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {tip && open && <DimensionTip id={tipId} text={tip} />}
      </AnimatePresence>
    </div>
  );
}

// Shared modal frame (light scrim, frosted card, title + close button).
// Closes on the × button, the Escape key, or a click on the scrim.
//
// Rendered through a portal into <body>: the dashboard's content wrapper
// (`relative z-10`) and the frosted cards (`backdrop-blur`) each create their
// own stacking context, so a modal nested inside them can never paint above
// the fixed Navbar no matter how high its z-index is. Escaping to <body>
// fixes that, and the Navbar now dims with the rest of the page.
//
// CHANGED: the scrim fades in and the dialog scales/slides up (enter animation only).
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Only rendered after a click on an "i" button, so `document` always exists here.
  return createPortal(
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#e9e8f4]/[0.72] p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[368px] flex-col gap-[14px] overflow-y-auto rounded-[24px] border-[1.5px] border-white bg-white/[0.88] p-6 shadow-[0_12px_36px_rgba(17,24,39,0.08)] backdrop-blur-[12px]"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <p id={titleId} className="text-[13px] font-bold uppercase text-[#4b5563]">
            {title}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[#4b5563] transition hover:text-[#111827]"
          >
            <X className="size-[14px]" strokeWidth={2.5} />
          </button>
        </div>

        {children}
      </motion.div>
    </motion.div>,
    document.body
  );
}

// "How Your ATS Score is Calculated" modal (Figma: ATS Score Calculation Modal)
function AtsScoreModal({
  score,
  sections,
  onClose,
}: {
  score: number | null;
  sections: SectionData[];
  onClose: () => void;
}) {
  const rows = sections.map((section) => {
    const weight = getWeight(section.name);
    const pct = section.value === null ? null : clampPercent(section.value);
    return {
      name: section.name,
      pct,
      weight,
      points:
        weight === undefined || pct === null ? undefined : (pct * weight) / 100,
    };
  });

  // Only sum the dimensions when every one of them has a score and a known weight.
  const allWeighted = rows.length > 0 && rows.every((row) => row.points !== undefined);
  const total = allWeighted ? rows.reduce((sum, row) => sum + (row.points ?? 0), 0) : null;

  const totalText =
    total === null
      ? score === null
        ? '—'
        : `${score}%`
      : Number.isInteger(total)
        ? `${total}%`
        : `${formatPoints(total)}% ≈ ${Math.round(total)}% (rounded)`;

  return (
    <ModalShell title="How Your ATS Score is Calculated" onClose={onClose}>
      {/* Calculation table */}
      <div className="flex flex-col gap-[10px] rounded-[16px] border border-[#e5e7eb] bg-white p-[14px]">
        {rows.map((row) => (
          <div key={row.name} className="flex h-8 items-center justify-between gap-2">
            <p
              className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#111827]"
              title={row.name}
            >
              {row.name}
            </p>
            <p className="w-[40px] shrink-0 text-right text-[12px] font-bold text-[#111827]">
              {row.pct === null ? '—' : `${Math.round(row.pct)}%`}
            </p>
            <p className="w-[48px] shrink-0 text-right text-[12px] font-semibold text-[#4b5563]">
              {row.weight === undefined ? '—' : `× ${row.weight}%`}
            </p>
            <p className="w-[48px] shrink-0 text-right text-[12px] font-bold text-[#111827]">
              {row.points === undefined ? '—' : formatPoints(row.points)}
            </p>
          </div>
        ))}

        <div className="h-px w-full bg-[#e5e7eb]" />

        <div className="flex min-h-8 items-center justify-between gap-4 text-[13px] text-[#111827]">
          <p className="font-bold">Total ATS Score</p>
          <p className="text-right font-extrabold">{totalText}</p>
        </div>
      </div>

      {/* Formula note */}
      <div className="rounded-[12px] border border-[#7c3aed]/20 bg-[#7c3aed]/[0.07] p-3">
        <p className="text-[11px] font-medium leading-[1.35] text-[#7c3aed]">
          ATS Score = Σ (Dimension Score × Weight)
        </p>
      </div>
    </ModalShell>
  );
}

// "How Dimensions Are Measured" modal (Figma: Dimension Analysis Popup)
function DimensionGuideModal({
  sections,
  onClose,
}: {
  sections: SectionData[];
  onClose: () => void;
}) {
  return (
    <ModalShell title="How Dimensions Are Measured" onClose={onClose}>
      {/* Dimension guide */}
      <div className="flex flex-col gap-[10px] rounded-[16px] border border-[#e5e7eb] bg-white p-[14px]">
        {sections.map((section) => {
          const description = getDescription(section.name);
          return (
            <div
              key={section.name}
              className="flex flex-col gap-1 border-b border-[#e5e7eb] pb-[9px]"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-[13px] font-bold text-[#111827]">
                  {section.name}
                </p>
                {section.value !== null && (
                  <p className="shrink-0 text-[11px] font-bold text-[#7c3aed]">
                    {Math.round(clampPercent(section.value))}%
                  </p>
                )}
              </div>
              {description && (
                <p className="text-[11px] leading-[1.3] text-[#4b5563]">{description}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Scoring note */}
      <div className="rounded-[12px] border border-[#7c3aed]/20 bg-[#7c3aed]/[0.07] p-[11px]">
        <p className="text-[11px] leading-[1.35] text-[#7c3aed]">
          Each score reflects how consistently your resume meets ATS and recruiter best practices.
        </p>
      </div>
    </ModalShell>
  );
}

export default function AssessmentSidebar({ score, sections }: AssessmentSidebarProps) {
  // Which explanation modal (if any) is open
  const [openModal, setOpenModal] = useState<'score' | 'dimensions' | null>(null);
  const closeModal = () => setOpenModal(null);

  const hasResult = score !== null;
  // Before analysis, list the standard dimensions with "-" values
  const rows = hasResult && sections && sections.length > 0 ? sections : EMPTY_SECTIONS;

  return (
    <div className="flex flex-col gap-6">
      {/* Overall Assessment card with score chart */}
      <div className={CARD_CLASS}>
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-bold uppercase text-[#4b5563]">Overall Assessment</h2>
          <InfoButton
            label="How is the ATS score calculated?"
            onClick={() => setOpenModal('score')}
          />
        </div>

        {/* key={score}: replays the ring animation when a new score arrives */}
        <ScoreChart key={score ?? 'none'} score={score} />

        {/* Summary note */}
        <div className="rounded-[12px] border border-[#7c3aed]/20 bg-[#7c3aed]/[0.07] p-3">
          <p className="text-[13px] font-medium leading-[1.4] text-[#7c3aed]">
            {hasResult
              ? getScoreSummary(score)
              : 'Your ATS score appears here after a resume is uploaded and analyzed.'}
          </p>
        </div>
      </div>

      {/* Dimension Analysis card with per-section bars */}
      <div className={CARD_CLASS}>
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-bold uppercase text-[#4b5563]">Dimension Analysis</h3>
          <InfoButton
            label="How are the dimensions measured?"
            onClick={() => setOpenModal('dimensions')}
          />
        </div>

        <div className="flex flex-col gap-4">
          {rows.map((section, i) => {
            // Only after analysis, and only for dimensions below the "meets" line.
            const tip =
              hasResult && section.value !== null && clampPercent(section.value) < MEETS_SCORE
                ? getTip(section.name)
                : undefined;

            return (
              // key includes the score so a new analysis closes any open tip
              <DimensionItem
                key={`${section.name}-${hasResult ? score : 'none'}`}
                name={section.name}
                value={section.value}
                index={i}
                tip={tip}
                showSlot={hasResult}
              />
            );
          })}
        </div>
      </div>

      {openModal === 'score' && (
        <AtsScoreModal score={score} sections={rows} onClose={closeModal} />
      )}
      {openModal === 'dimensions' && (
        <DimensionGuideModal sections={rows} onClose={closeModal} />
      )}
    </div>
  );
}