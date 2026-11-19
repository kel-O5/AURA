// src/app/home/page.tsx
// Home / landing page. Everything lives in this one file:
//   1. Shared styles + static content (arrays that drive each section)
//   2. Small presentational components (SectionHeader, FAQ, ContactForm)
//   3. The page itself (HomePage)

'use client';

import { Fragment, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { DM_Sans } from 'next/font/google';
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  Gauge,
  Layers,
  Lightbulb,
  Lock,
  Mail,
  Music2,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react';

// ADDED: scroll-in animation wrapper (file is src/components/reveal.tsx).
import Reveal from '@/components/reveal';

// The Figma design uses DM Sans throughout.
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

// Shown in the Contact section and used as the recipient of the contact form.
const CONTACT_EMAIL = 'hello@aura.ai';

// ───────────── Shared styles ─────────────

// Frosted-glass card used by the step, feature and pillar cards.
const CARD =
  'rounded-[20px] border-[1.5px] border-white bg-white/[0.72] shadow-[0_4px_16px_rgba(124,58,237,0.03),0_16px_48px_rgba(17,24,39,0.06)] backdrop-blur-[12px]';

// Brand gradient (violet -> cyan). Kept as a full class string so Tailwind can detect it.
const GRADIENT_BG = 'bg-[linear-gradient(90deg,#7c3aed_0%,#a78bfa_60%,#06b6d4_100%)]';
const GRADIENT_TEXT = `${GRADIENT_BG} bg-clip-text text-transparent`;

// ADDED: hover lift for buttons (with reduced-motion support).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0';

// Tinted icon tiles (background + icon color)
const TILE = {
  violet: 'bg-[#8b5cf6]/10 text-[#8b5cf6]',
  cyan: 'bg-[#06b6d4]/10 text-[#06b6d4]',
  amber: 'bg-[#f59e0b]/10 text-[#f59e0b]',
  emerald: 'bg-[#10b981]/10 text-[#10b981]',
} as const;

// ───────────── Content ─────────────
const HIGHLIGHTS: { icon: LucideIcon; color: string; label: string }[] = [
  { icon: CheckCircle2, color: 'text-[#10b981]', label: 'ATS Friendly' },
  { icon: Zap, color: 'text-[#f59e0b]', label: 'Instant Analysis' },
  { icon: Lightbulb, color: 'text-[#8b5cf6]', label: 'Smart Suggestions' },
  { icon: Gauge, color: 'text-[#06b6d4]', label: 'ATS Score' },
  { icon: Lock, color: 'text-[#7c3aed]', label: '100% Private' },
];

const STEPS = [
  {
    badge: 'Step 1',
    badgeClass: 'bg-[#ede9fe] text-[#7c3aed]',
    title: 'Upload Your Resume',
    text: 'Drag and drop your existing PDF, DOC, or DOCX document into our workspace secure portal.',
  },
  {
    badge: 'Step 2',
    badgeClass: 'bg-[#cffafe] text-[#06b6d4]',
    title: 'Get AI Analysis',
    text: 'Within 30 seconds, review a deep diagnosis of keyword weights, format compatibility, and verb metrics.',
  },
  {
    badge: 'Step 3',
    badgeClass: 'bg-[#ecfdf5] text-[#10b981]',
    title: 'Download & Apply',
    text: 'Incorporate high-priority suggestions, download your ATS-ready resume file, and submit.',
  },
];

const FEATURES: { icon: LucideIcon; tile: string; title: string; text: string }[] = [
  {
    icon: Brain,
    tile: TILE.violet,
    title: 'Resume Content Analysis',
    text: 'Our advanced language models scan your document to provide instant feedback on content strength, verb usage, and readability.',
  },
  {
    icon: ShieldCheck,
    tile: TILE.cyan,
    title: 'ATS Score Checking',
    text: 'Verify if your layout is optimized for parsing tools. Avoid templates with broken tables, text columns, or bad fonts.',
  },
  {
    icon: Search,
    tile: TILE.amber,
    title: 'Smart Suggestions',
    text: 'Compare your resume directly with real-world job descriptions. Add crucial search keys that human screeners look for.',
  },
  {
    icon: Gauge,
    tile: TILE.emerald,
    title: 'Dimension Analysis',
    text: 'Receive an objective 0-100 score based on standard industry thresholds. Your score is calculated across Keyword Match, Format Compliance, Section Structure, and Impact Metrics, giving you a clear benchmark before applying.',
  },
  {
    icon: Target,
    tile: TILE.violet,
    title: 'Top Company Matches',
    text: 'Select specific top-tier companies. AURA adapts its insights to match historical templates favored by those team structures.',
  },
  {
    icon: Lock,
    tile: TILE.cyan,
    title: 'Privacy Protection',
    text: 'Your upload is safely analyzed using advanced encryption. Data is completely discarded after download. 100% private.',
  },
];

// The four scoring pillars. The weights should add up to 100%.
const PILLARS: {
  icon: LucideIcon;
  tile: string;
  badgeClass: string;
  weight: string;
  title: string;
  text: string;
}[] = [
  {
    icon: Search,
    tile: TILE.violet,
    badgeClass: 'bg-[#ede9fe] text-[#7c3aed]',
    weight: '35% Weight',
    title: 'Keyword Match',
    text: 'Analyzes industry-specific skills and target role terminology based on the BERT model.',
  },
  {
    icon: ShieldCheck,
    tile: TILE.cyan,
    badgeClass: 'bg-[#cffafe] text-[#06b6d4]',
    weight: '25% Weight',
    title: 'Format Compliance',
    text: 'Verifies standard typography, fonts, and clean layout patterns to ensure flawless ATS parsing.',
  },
  {
    icon: Layers,
    tile: TILE.emerald,
    badgeClass: 'bg-[#ecfdf5] text-[#10b981]',
    weight: '20% Weight',
    title: 'Section Structure',
    text: 'Ensures correct categorization of Work History, Education, Skills, and Contact headings.',
  },
  {
    icon: TrendingUp,
    tile: TILE.amber,
    badgeClass: 'bg-[#fef3c7] text-[#d97706]',
    weight: '20% Weight',
    title: 'Impact Metrics',
    text: 'Measures usage of strong action verbs and quantified accomplishments (%, $, times).',
  },
];

// FAQ is split into two lists so it can render as two columns on desktop.
const FAQ_LEFT = [
  {
    question: 'What is an ATS score?',
    answer:
      'An ATS (Applicant Tracking System) score is a diagnostic measurement representing how easily automated resume screening software parses, reads, and prioritizes your professional profile relative to target roles.',
  },
  {
    question: 'How does AURA analyze my resume?',
    answer:
      'We leverage a fine-tuned BERT language architecture combined with modern ATS parsing schemas to analyze document headings, font patterns, keyword relevance weights, and quantified achievements.',
  },
  {
    question: 'Is AURA free to use?',
    answer:
      'Yes, you can upload and analyze your resume for an overall diagnostic score completely free of charge. Premium tier unlocks detailed recommendations.',
  },
];

const FAQ_RIGHT = [
  {
    question: 'What file formats are supported?',
    answer:
      'We support native PDF, DOC, and DOCX text files up to 10MB in size. We recommend standard text-based PDFs for maximum layout evaluation accuracy.',
  },
  {
    question: 'Is my personal data safe?',
    answer:
      'Absolutely. Security is our absolute priority. All processed documents are instantly encrypted during parsing and completely destroyed immediately after download.',
  },
  {
    question: 'How long does the analysis take?',
    answer:
      "AURA analyzes your resume in under 30 seconds. You'll receive your ATS score, keyword gaps, and actionable suggestions almost instantly.",
  },
];

// ───────────── Brand glyphs ─────────────
// lucide-react has no brand icons, so these are inlined SVGs sharing one set of props.
const glyphProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const InstagramGlyph = () => (
  <svg {...glyphProps}>
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
  </svg>
);

const FacebookGlyph = () => (
  <svg {...glyphProps}>
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);

const LinkedinGlyph = () => (
  <svg {...glyphProps}>
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
    <rect x="2" y="9" width="4" height="12" />
    <circle cx="4" cy="4" r="2" />
  </svg>
);

// Music2 (TikTok stand-in) comes from lucide; the rest are the inline glyphs above.
const SOCIALS: { glyph: ReactNode; tile: string; text: string }[] = [
  { glyph: <InstagramGlyph />, tile: 'bg-[#fff0f5] text-[#e1306c]', text: '@aaboraura' },
  { glyph: <FacebookGlyph />, tile: 'bg-[#eff6ff] text-[#1877f2]', text: 'AURA Resume' },
  { glyph: <Music2 className="size-4" aria-hidden />, tile: 'bg-[#f3f4f6] text-[#111827]', text: '@aaboraura' },
  { glyph: <LinkedinGlyph />, tile: 'bg-[#ecfeff] text-[#0a66c2]', text: 'AURA' },
];

// ───────────── Section heading ─────────────
// `accent` is the gradient-colored part of the title, rendered right after `before`.
// `size` picks the smaller title used for the sub-heading inside Features.
// CHANGED: the root is now wrapped in <Reveal>. The wrapper is `flex w-full justify-center`
// so the heading stays centered exactly like before.
function SectionHeader({
  before,
  accent,
  subtitle,
  size = 'lg',
}: {
  before: string;
  accent?: string;
  subtitle: string;
  size?: 'lg' | 'md';
}) {
  return (
    <Reveal className="flex w-full justify-center">
      <div className="flex w-full max-w-[800px] flex-col items-center gap-4 text-center">
        <h2
          className={`font-extrabold leading-[1.2] text-[#111827] ${
            size === 'lg' ? 'text-[32px] sm:text-[40px]' : 'text-[26px] sm:text-[32px]'
          }`}
        >
          {before}
          {accent && <span className={GRADIENT_TEXT}>{accent}</span>}
        </h2>
        <p className="max-w-[600px] text-[16px] leading-[1.6] text-[#6b7280]">{subtitle}</p>
      </div>
    </Reveal>
  );
}

// ───────────── FAQ accordion ─────────────
type FaqEntry = {
  question: string;
  answer: string;
};

// One expandable question. Starts closed; click to open.
function FaqItem({ question, answer }: FaqEntry) {
  const [open, setOpen] = useState(false);
  // Links the toggle button to the answer panel for screen readers.
  const panelId = useId();

  return (
    <div className="flex flex-col gap-3 rounded-[16px] border border-white bg-white/[0.72] p-6 shadow-[0_4px_12px_rgba(31,41,55,0.02)]">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <span className="min-w-0 flex-1 text-[16px] font-bold text-[#111827]">{question}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-[#4b5563] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <p id={panelId} className="text-[14px] leading-[1.5] text-[#4b5563]">
          {answer}
        </p>
      )}
    </div>
  );
}

// CHANGED: each FAQ item is wrapped in <Reveal> with a small stagger.
function FaqList({ items }: { items: FaqEntry[] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      {items.map((item, i) => (
        <Reveal key={item.question} delay={i * 0.1}>
          <FaqItem question={item.question} answer={item.answer} />
        </Reveal>
      ))}
    </div>
  );
}

// ───────────── Contact form ─────────────

// Deliberately loose check ("something@something.tld"); it only catches typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldName = 'firstName' | 'lastName' | 'email' | 'message';
type FieldErrors = Partial<Record<FieldName, string>>;

// Input/textarea styling; switches to red border + ring when the field has an error.
const fieldClass = (hasError: boolean) =>
  [
    'w-full rounded-[10px] border bg-white px-[14px] py-[12px] text-[14px] text-[#111827]',
    'shadow-[0_1px_1.5px_rgba(17,24,39,0.04)] outline-none transition placeholder:text-[#9ca3af]',
    hasError
      ? 'border-[#ef4444] focus:ring-2 focus:ring-[#ef4444]/15'
      : 'border-[#e5e7eb] focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15',
  ].join(' ');

// Contact form card from the Figma landing page.
// There is no contact API yet, so a valid submit opens the visitor's email app
// with the message pre-filled and addressed to `email`. When a backend endpoint
// exists, replace the body of `sendMessage` with a fetch() to it.
function ContactForm({ email }: { email: string }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  // True after a successful submit; drives the "your email app should open" note.
  const [opened, setOpened] = useState(false);

  // Called on every keystroke: drops that field's error and hides the success
  // note, since the message it refers to has now been edited.
  const clearError = (field: FieldName) => {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    if (opened) setOpened(false);
  };

  // Builds a mailto: link and clicks it. Using a temporary <a> opens the
  // visitor's mail client without navigating the page away.
  const sendMessage = () => {
    const name = `${firstName.trim()} ${lastName.trim()}`;
    const subject = `Message from ${name}`;
    const body = `${message.trim()}\n\n— ${name} (${fromEmail.trim()})`;
    const link = document.createElement('a');
    link.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    link.click();
  };

  const handleSubmit = () => {
    const next: FieldErrors = {};
    if (!firstName.trim()) next.firstName = 'This field is required';
    if (!lastName.trim()) next.lastName = 'This field is required';
    if (!fromEmail.trim()) next.email = 'Email is required';
    else if (!EMAIL_RE.test(fromEmail.trim())) next.email = 'Invalid email address';
    if (!message.trim()) next.message = 'Please enter a message';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    sendMessage();
    setOpened(true);
  };

  return (
    <form
      // noValidate: use our own error messages instead of the browser's popups.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      className="flex w-full flex-col gap-5 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] p-6 shadow-[0_4px_16px_rgba(124,58,237,0.03),0_16px_48px_rgba(17,24,39,0.06)] backdrop-blur-[12px] sm:p-10 lg:min-w-0 lg:flex-[1.24]"
    >
      {/* Name row */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <label htmlFor="contact-first-name" className="text-[13px] font-semibold text-[#374151]">
            First Name
          </label>
          <input
            id="contact-first-name"
            type="text"
            autoComplete="given-name"
            placeholder="Enter your first name..."
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              clearError('firstName');
            }}
            aria-invalid={!!errors.firstName}
            className={fieldClass(!!errors.firstName)}
          />
          {errors.firstName && <p className="text-[12px] text-[#ef4444]">{errors.firstName}</p>}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <label htmlFor="contact-last-name" className="text-[13px] font-semibold text-[#374151]">
            Last Name
          </label>
          <input
            id="contact-last-name"
            type="text"
            autoComplete="family-name"
            placeholder="Enter your last name..."
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              clearError('lastName');
            }}
            aria-invalid={!!errors.lastName}
            className={fieldClass(!!errors.lastName)}
          />
          {errors.lastName && <p className="text-[12px] text-[#ef4444]">{errors.lastName}</p>}
        </div>
      </div>

      {/* Email */}
      <div className="flex flex-col gap-[6px]">
        <label htmlFor="contact-email" className="text-[13px] font-semibold text-[#374151]">
          Email
        </label>
        <input
          id="contact-email"
          type="email"
          autoComplete="email"
          placeholder="Enter your email address..."
          value={fromEmail}
          onChange={(e) => {
            setFromEmail(e.target.value);
            clearError('email');
          }}
          aria-invalid={!!errors.email}
          className={fieldClass(!!errors.email)}
        />
        {errors.email && <p className="text-[12px] text-[#ef4444]">{errors.email}</p>}
      </div>

      {/* Message */}
      <div className="flex flex-col gap-[6px]">
        <label htmlFor="contact-message" className="text-[13px] font-semibold text-[#374151]">
          How can we help you?
        </label>
        <textarea
          id="contact-message"
          placeholder="Enter your message..."
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            clearError('message');
          }}
          aria-invalid={!!errors.message}
          className={`${fieldClass(!!errors.message)} h-[160px] resize-none leading-[1.5]`}
        />
        {errors.message && <p className="text-[12px] text-[#ef4444]">{errors.message}</p>}
      </div>

      {/* Submit row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-[#9ca3af]">We&apos;ll get back to you within 24 hours.</p>

        {/* CHANGED: `transition` -> BTN_MOTION (hover lift) */}
        <button
          type="submit"
          className={`flex items-center justify-center gap-[10px] rounded-full ${GRADIENT_BG} py-[14px] pl-7 pr-5 text-[15px] font-bold text-white shadow-[0_2px_3px_rgba(124,58,237,0.1),0_8px_12px_rgba(124,58,237,0.25)] ${BTN_MOTION} hover:brightness-105 active:brightness-95`}
        >
          Send Message
          <span className="flex size-[26px] items-center justify-center rounded-full bg-white/[0.13]">
            <ArrowRight className="size-[13px]" />
          </span>
        </button>
      </div>

      {opened && (
        <p role="status" className="text-[13px] font-medium text-[#10b981]">
          Your email app should open with your message ready to send.
        </p>
      )}
    </form>
  );
}

// ───────────── Page ─────────────
// Reveal wrappers get layout classes (flex-1, h-full, etc.) so the extra <div>
// they add does not change any sizing or alignment.
export default function HomePage() {
  return (
    <div
      className={`${dmSans.className} relative flex min-h-screen w-full flex-col overflow-x-clip bg-[#f0eeff]`}
    >
      {/* ───────────── Decorative background ─────────────
          Blob and ring offsets are absolute pixel values tuned to the Figma page
          height, so re-check them if section heights change a lot. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Soft color blobs, top to bottom */}
        <div className="absolute -left-[220px] -top-[220px] size-[940px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.38)_0%,rgba(167,139,250,0.16)_38%,rgba(167,139,250,0)_70%)]" />
        <div className="absolute -right-[220px] top-[60px] size-[800px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.30)_0%,rgba(34,211,238,0.12)_40%,rgba(34,211,238,0)_70%)]" />
        <div className="absolute left-[calc(50%-250px)] top-[1070px] size-[620px] rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.18)_0%,rgba(251,113,133,0.06)_40%,rgba(251,113,133,0)_70%)]" />
        <div className="absolute left-0 top-[2100px] size-[500px] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.24)_0%,rgba(251,191,36,0.09)_40%,rgba(251,191,36,0)_70%)]" />
        <div className="absolute -right-[250px] top-[3050px] size-[800px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.30)_0%,rgba(167,139,250,0.12)_40%,rgba(167,139,250,0)_70%)]" />
        <div className="absolute left-[20px] top-[4070px] size-[710px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.26)_0%,rgba(34,211,238,0.10)_40%,rgba(34,211,238,0)_70%)]" />

        {/* Dot grid, kept faint (6% opacity) */}
        <div className="absolute inset-0 bg-[radial-gradient(circle,#7c3aed_1px,transparent_1px)] bg-[length:24px_24px] opacity-[0.06]" />

        {/* Top accent line */}
        <div className="absolute left-0 top-0 h-[3px] w-full bg-[linear-gradient(90deg,#7c3aed_0%,#06b6d4_50%,rgba(139,92,246,0)_100%)]" />

        {/* Decorative rings */}
        <div className="absolute -right-[120px] -top-[120px] size-[340px] rounded-full border border-[#8b5cf6]/20" />
        <div className="absolute -right-[80px] -top-[80px] size-[260px] rounded-full border border-[#8b5cf6]/20" />
        <div className="absolute left-[60px] top-[1500px] size-[180px] rounded-full border border-emerald-400/20" />
        <div className="absolute left-[100px] top-[1540px] size-[100px] rounded-full border border-emerald-400/20" />
      </div>

      {/* Top padding leaves room for the fixed site navbar (rendered by the layout) */}
      <main className="relative z-10 flex w-full flex-col pt-[96px]">
        {/* ───────────── Hero ─────────────
            Each hero piece reveals in sequence (staggered delays). */}
        <section className="flex flex-col items-center gap-7 px-6 pb-4 pt-[72px] text-center sm:px-10 lg:px-20">
          <Reveal delay={0}>
            <div className="flex items-center gap-[7px] rounded-full border border-[#10b981]/20 bg-[#ecfdf5] px-4 py-[7px] shadow-[0_2px_4px_rgba(16,185,129,0.1)]">
              <Sparkles className="size-[14px] text-[#10b981]" />
              <span className="text-[13px] font-semibold text-[#047857]">Powered by BERT</span>
            </div>
          </Reveal>

          <Reveal delay={0.1} className="flex flex-col items-center">
            <h1 className="max-w-[960px] text-[40px] font-extrabold leading-[1.1] text-[#111827] sm:text-[56px] lg:text-[68px]">
              Your Resume,
              <br />
              Perfected by <span className={GRADIENT_TEXT}>AI Intelligence.</span>
            </h1>
          </Reveal>

          <Reveal delay={0.2} className="flex flex-col items-center">
            <p className="max-w-[580px] text-[16px] leading-[1.65] text-[#4b5563] sm:text-[18px]">
              Optimize your resume for applicant tracking systems, discover hidden keyword gaps, and
              stand out to hiring managers in seconds.
            </p>
          </Reveal>

          <Reveal delay={0.3}>
            <div className="pt-6">
              {/* CHANGED: `transition` -> BTN_MOTION (hover lift) */}
              <Link
                href="/signup"
                className={`flex items-center justify-center rounded-full ${GRADIENT_BG} px-8 py-4 text-[15px] font-bold text-white shadow-[0_8px_12px_rgba(124,58,237,0.2)] ${BTN_MOTION} hover:brightness-105 active:brightness-95`}
              >
                Get Started
              </Link>
            </div>
          </Reveal>
        </section>

        {/* ───────────── Feature highlight pills ───────────── */}
        <section className="flex flex-wrap items-center justify-center gap-4 px-6 py-12 sm:px-10 lg:px-20">
          {HIGHLIGHTS.map(({ icon: Icon, color, label }, i) => (
            <Reveal key={label} delay={i * 0.08}>
              <div className="flex items-center gap-2 rounded-full border border-white/80 bg-white/[0.63] px-[18px] py-[10px] backdrop-blur-[8px]">
                <Icon className={`size-5 ${color}`} />
                <span className="text-[13px] font-semibold text-[#4b5563]">{label}</span>
              </div>
            </Reveal>
          ))}
        </section>

        {/* ───────────── How it works ───────────── */}
        <section className="flex flex-col items-center gap-12 px-6 py-16 sm:px-10 lg:p-20">
          <SectionHeader
            before="How "
            accent="It Works"
            subtitle="We have simplified professional enhancement. No tedious form filling, just fast results."
          />

          {/* Steps stack on mobile; on desktop they sit in a row with an arrow between each */}
          <div className="flex w-full flex-col gap-6 lg:flex-row lg:items-center lg:gap-8">
            {STEPS.map((step, i) => (
              <Fragment key={step.badge}>
                <Reveal delay={i * 0.12} className="flex flex-1 lg:min-w-0">
                  <div className={`${CARD} flex flex-1 flex-col items-start gap-5 p-7 lg:min-w-0`}>
                    <span
                      className={`rounded-full px-3 py-1 text-[12px] font-bold leading-none ${step.badgeClass}`}
                    >
                      {step.badge}
                    </span>
                    <div className="flex w-full flex-col gap-2">
                      <h3 className="text-[18px] font-bold text-[#111827]">{step.title}</h3>
                      <p className="text-[14px] leading-[1.5] text-[#4b5563]">{step.text}</p>
                    </div>
                  </div>
                </Reveal>

                {/* No arrow after the last step, and none on mobile */}
                {i < STEPS.length - 1 && (
                  <ArrowRight aria-hidden className="hidden size-6 shrink-0 text-[#9ca3af] lg:block" />
                )}
              </Fragment>
            ))}
          </div>
        </section>

        {/* ───────────── Features (+ scoring pillars) ─────────────
            scroll-mt-28 keeps the section title clear of the fixed navbar
            when the navbar links jump to #features / #faq / #contact. */}
        <section
          id="features"
          className="flex scroll-mt-28 flex-col items-center gap-12 px-6 py-16 sm:px-10 lg:p-20"
        >
          <SectionHeader
            before="Features"
            subtitle="Build a tailored, high-converting professional document with our intuitive suite of neural optimization tools."
          />

          <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, tile, title, text }, i) => (
              <Reveal key={title} delay={(i % 3) * 0.1} className="h-full">
                <div className={`${CARD} flex h-full flex-col items-start gap-4 p-7`}>
                  <div className={`flex size-10 shrink-0 items-center justify-center rounded-[12px] ${tile}`}>
                    <Icon className="size-5" />
                  </div>
                  <div className="flex w-full flex-col gap-2">
                    <h3 className="text-[18px] font-bold text-[#111827]">{title}</h3>
                    <p className="text-[14px] leading-[1.5] text-[#4b5563]">{text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Score breakdown: explains the four pillars behind "Dimension Analysis" above */}
          <div className="flex w-full flex-col items-center gap-12 pt-4">
            <SectionHeader
              size="md"
              before="How Your ATS Score "
              accent="Is Computed"
              subtitle="Our neural network evaluates your resume across four core diagnostic pillars used by modern recruitment tools."
            />

            <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
              {PILLARS.map(({ icon: Icon, tile, badgeClass, weight, title, text }, i) => (
                <Reveal key={title} delay={(i % 4) * 0.1} className="h-full">
                  <div className={`${CARD} flex h-full flex-col items-start gap-5 p-7`}>
                    <div className="flex w-full items-center justify-between">
                      <div className={`flex size-10 shrink-0 items-center justify-center rounded-[12px] ${tile}`}>
                        <Icon className="size-5" />
                      </div>
                      <span className={`rounded-full px-[10px] py-1 text-[12px] font-bold leading-none ${badgeClass}`}>
                        {weight}
                      </span>
                    </div>
                    <div className="flex w-full flex-col gap-2">
                      <h3 className="text-[20px] font-bold text-[#111827]">{title}</h3>
                      <p className="text-[14px] leading-[1.5] text-[#4b5563]">{text}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────── FAQ ───────────── */}
        <section
          id="faq"
          className="flex scroll-mt-28 flex-col items-center gap-12 px-6 py-16 sm:px-10 lg:p-20"
        >
          <SectionHeader
            before="Frequently Asked "
            accent="Questions"
            subtitle="Everything you need to know about navigating applicant tracking filters with AURA."
          />

          <div className="flex w-full flex-col items-start gap-4 lg:flex-row lg:gap-12">
            <FaqList items={FAQ_LEFT} />
            <FaqList items={FAQ_RIGHT} />
          </div>
        </section>

        {/* ───────────── Contact ───────────── */}
        <section
          id="contact"
          className="mx-auto flex w-full max-w-[1400px] scroll-mt-28 flex-col gap-10 px-6 py-16 sm:px-10 lg:flex-row lg:items-start lg:gap-12 lg:px-12 lg:py-[100px] xl:gap-20 xl:px-[100px]"
        >
          {/* CHANGED: this column's <div> is now a <Reveal> carrying the same classes */}
          <Reveal className="flex w-full flex-col gap-9 lg:min-w-0 lg:flex-1">
            <div className="flex flex-col gap-5">
              <div className="h-[3px] w-12 rounded-[2px] bg-[linear-gradient(90deg,#7c3aed_0%,#06b6d4_100%)]" />
              <h2 className="text-[40px] font-extrabold leading-[1.1] text-[#111827] sm:text-[52px]">
                Contact<span className={GRADIENT_TEXT}> us</span>
              </h2>
              <p className="text-[16px] leading-[1.7] text-[#6b7280]">
                We&apos;re here to help! Whether you have a question about our services, need
                assistance with your account, or want to provide feedback, our team is ready to
                assist you.
              </p>
            </div>

            <div className="flex flex-col gap-7">
              <div className="flex flex-col gap-2">
                <p className="text-[12px] font-bold uppercase text-[#9ca3af]">Email</p>
                <div className="flex items-center gap-[10px]">
                  <span className="flex size-8 items-center justify-center rounded-[8px] bg-[#ede9fe] text-[#7c3aed]">
                    <Mail className="size-4" />
                  </span>
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-[15px] font-bold text-[#111827] hover:underline">
                    {CONTACT_EMAIL}
                  </a>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <p className="text-[12px] font-bold uppercase text-[#9ca3af]">Follow us</p>
                <div className="flex flex-col gap-[10px]">
                  {/* Index is part of the key because two handles share the same text */}
                  {SOCIALS.map((social, i) => (
                    <div key={`${social.text}-${i}`} className="flex items-center gap-[10px]">
                      <span className={`flex size-8 items-center justify-center rounded-[8px] ${social.tile}`}>
                        {social.glyph}
                      </span>
                      <span className="text-[14px] text-[#4b5563]">{social.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>

          {/* CHANGED: form is wrapped in <Reveal>; the wrapper takes the flex sizing */}
          <Reveal delay={0.15} className="w-full lg:min-w-0 lg:flex-[1.24]">
            <ContactForm email={CONTACT_EMAIL} />
          </Reveal>
        </section>
      </main>
    </div>
  );
}