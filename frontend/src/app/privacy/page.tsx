// src/app/privacy/page.tsx

import { DM_Sans } from 'next/font/google';
import {
  Check,
  Info,
  Database,
  Activity,
  Lock,
  Share2,
  UserCheck,
  Settings,
  Clock,
  Mail,
  type LucideIcon,
} from 'lucide-react';
import TableOfContents, { MobileTableOfContents } from '../../features/privacy-tos/TableOfContents';
// Scroll-in animation wrapper (client component, safe to use in this server page).
import Reveal from '@/components/reveal';

export const metadata = {
  title: 'Privacy Policy – Aura',
  description: 'How Aura collects, uses, and protects your data.',
};

// Figma uses DM Sans throughout.
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

type Section = {
  icon: LucideIcon;
  title: string;
  description: string;
  content: { subtitle: string; text: string }[];
};

const SECTIONS: Section[] = [
  {
    icon: Info,
    title: 'Introduction',
    description: 'Why we wrote this policy',
    content: [
      {
        subtitle: '',
        text: 'Welcome to Aura (referred to as "Aura", "we", "us", or "our"). At Aura, we are deeply committed to protecting your personal privacy. This Privacy Policy outlines the types of personal data and resume information we collect, how it is processed and analyzed, and the stringent security measures in place to safeguard your data.',
      },
      {
        subtitle: '',
        text: 'By accessing our platform and uploading resumes, you consent to the data collection and usage practices described in this document. If you do not agree to these terms, please do not use the service.',
      },
    ],
  },
  {
    icon: Database,
    title: 'Information We Collect',
    description: 'The data categories we gather',
    content: [
      {
        subtitle: '',
        text: 'To provide our high-fidelity resume optimization and ATS-matching services, we collect several categories of data:',
      },
      {
        subtitle: '',
        text: '• Personal Account Details: Name, email address, registration logs, and billing details when purchasing premium upgrades.\n• Resume & Profile Information: Full PDF/DOCX resume file uploads, including professional experiences, contact information, education records, and skills lists.\n• Target Career Preferences: Target job titles, target industries, and list of preferred target companies.\n• Usage Metrics & Device Info: IP addresses, browser types, session activity, click paths, and metadata indicating which recommendations are accepted.',
      },
    ],
  },
  {
    icon: Activity,
    title: 'How We Use Your Information',
    description: 'What powers our AI engine',
    content: [
      {
        subtitle: '',
        text: 'We process your personal and professional information to run our core AI-powered engine and match your target parameters. Specifically, this covers:',
      },
      {
        subtitle: '',
        text: '• Resume Analysis: Parsing structures and computing ATS compliance percentages.\n• Recommendation Engine: Generating specific keyword insert tips, formatting suggestions, and skill checks.\n• Company Matching: Sourcing optimal local and remote target job options based on your target skills.\n• Model Tuning: Improving our proprietary text analysis and layout classification algorithms. We only use anonymized, aggregated text blocks for training.',
      },
    ],
  },
  {
    icon: Lock,
    title: 'Data Storage & Security',
    description: 'How your files are protected',
    content: [
      {
        subtitle: '',
        text: 'Data integrity is our utmost priority. All resume files and user settings are protected using strict enterprise-grade mechanisms:',
      },
      {
        subtitle: '',
        text: '• In-Transit Encryption: TLS 1.3 encryption protocols ensure secure connections when uploading documents.\n• At-Rest Encryption: AES-256 standard database and cloud bucket storage encryption.\n• Zero-Trust Architecture: Role-based access controls limit data accessibility solely to qualified support systems and your authenticated user session.',
      },
    ],
  },
  {
    icon: Share2,
    title: 'Sharing Your Information',
    description: 'When your data leaves Aura',
    content: [
      {
        subtitle: '',
        text: 'Aura does not rent, sell, or trade your personal or professional resume information to any third parties for marketing purposes. Your info is shared only in the following controlled scenarios:',
      },
      {
        subtitle: '',
        text: '• Authorized Sub-Processors: Secure database servers, transactional email senders, and secure credit card gateways.\n• External Integrations: If you choose to manually link or click-through to partner job listings.\n• Legal Mandates: To comply with a subpoena, court order, or applicable law if strictly necessary.',
      },
    ],
  },
  {
    icon: UserCheck,
    title: 'Your Rights & Choices',
    description: 'The control you have over your data',
    content: [
      {
        subtitle: '',
        text: 'You maintain absolute control over your career data and resume artifacts:',
      },
      {
        subtitle: '',
        text: '• Full Export: You have the right to request or instantly download a structured JSON archive of all parsed resume metadata.\n• Instant Erasure: You can permanently delete your resumes, dashboard statistics, or delete your entire Aura account within account settings.\n• Opt-out options: Block telemetry tracking or optional newsletters at any time.',
      },
    ],
  },
  {
    icon: Settings,
    title: 'Cookies & Tracking',
    description: 'How we use cookies on the platform',
    content: [
      {
        subtitle: '',
        text: 'We use cookie technologies to preserve active logins, optimize navigation, and keep our portal running securely:',
      },
      {
        subtitle: '',
        text: '• Essential cookies: Necessary to identify your account session and prevent data cross-contamination.\n• Analytics cookies: Aggregated, anonymized statistics to analyze page load speeds and locate software bugs.',
      },
    ],
  },
  {
    icon: Clock,
    title: 'Changes to This Policy',
    description: 'How updates are communicated',
    content: [
      {
        subtitle: '',
        text: 'Aura reserves the right to update this policy as security regulations change. In the event of a significant update, we will notify premium members and users through:',
      },
      {
        subtitle: '',
        text: '• An official banner notification displayed prominently upon login.\n• A direct email update sent to your registered address.',
      },
    ],
  },
  {
    icon: Mail,
    title: 'Contact Us',
    description: 'Reach our security team',
    content: [
      {
        subtitle: '',
        text: 'For general privacy questions, detailed data requests, or compliance inquiries, please get in touch with our security team:',
      },
      {
        subtitle: '',
        text: '• Email: analyzeaura@gmail.com',
      },
    ],
  },
];

const sectionId = (index: number) => `section-${index + 1}`;

// Content lines that all start with "•" are shown as a checklist (matching
// the Figma bullet style); anything else is rendered as a normal paragraph.
function ContentBlock({ text }: { text: string }) {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const isList = lines.length > 0 && lines.every((line) => line.trim().startsWith('•'));

  if (isList) {
    return (
      <div className="flex flex-col gap-[10px]">
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[10px] bg-[#7c3aed]/[0.09]">
              <Check className="size-[10px] text-[#7c3aed]" strokeWidth={3} />
            </span>
            <p className="flex-1 text-[14px] leading-[1.5] text-[#4b5563]">
              {line.trim().replace(/^•\s*/, '')}
            </p>
          </div>
        ))}
      </div>
    );
  }

  return <p className="whitespace-pre-line text-[15px] leading-[1.6] text-[#4b5563]">{text}</p>;
}

export default function PrivacyPolicyPage() {
  const tocItems = SECTIONS.map((section, i) => ({
    id: sectionId(i),
    label: `${i + 1}. ${section.title}`,
  }));

  return (
    <div
      className={`${dmSans.className} relative flex min-h-screen w-full flex-col overflow-x-clip bg-[#f0eeff]`}
    >
      {/* ───────────── Decorative background ───────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Soft colour orbs */}
        <div className="absolute -left-[220px] -top-[220px] size-[940px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.38)_0%,rgba(167,139,250,0.16)_38%,rgba(167,139,250,0)_70%)]" />
        <div className="absolute -right-[220px] top-[60px] size-[800px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.30)_0%,rgba(34,211,238,0.12)_40%,rgba(34,211,238,0)_70%)]" />
        <div className="absolute left-[calc(50%-250px)] top-[1070px] size-[620px] rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.18)_0%,rgba(251,113,133,0.06)_40%,rgba(251,113,133,0)_70%)]" />
        <div className="absolute left-0 top-[2100px] size-[500px] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.24)_0%,rgba(251,191,36,0.09)_40%,rgba(251,191,36,0)_70%)]" />

        {/* Top accent line */}
        <div className="absolute left-0 top-0 h-[3px] w-full bg-[linear-gradient(90deg,#7c3aed_0%,#06b6d4_50%,rgba(139,92,246,0)_100%)]" />

        {/* Decorative rings — top right */}
        <div className="absolute -right-[120px] -top-[120px] size-[340px] rounded-full border border-[#8b5cf6]/20" />
        <div className="absolute -right-[80px] -top-[80px] size-[260px] rounded-full border border-[#8b5cf6]/20" />
      </div>

      {/* Top padding leaves room for the fixed site navbar (rendered by the layout) */}
      <div className="relative z-10 mx-auto flex w-full max-w-[1440px] flex-col pt-[120px]">
        {/* ───────────── Hero ───────────── */}
        <Reveal>
          <header className="flex flex-col gap-3 px-6 py-10 sm:px-10 lg:px-20">
            <h1 className="text-[36px] font-extrabold leading-tight text-[#111827] sm:text-[48px]">
              Privacy Policy
            </h1>
            <p className="text-[16px] font-medium text-[#4b5563]">Last updated: September 1, 2026</p>
          </header>
        </Reveal>

        {/* ───────────── Sidebar + sections ───────────── */}
        <div className="flex flex-col gap-8 px-6 pb-20 sm:px-10 lg:flex-row lg:items-start lg:px-20">
          {/* Mobile / tablet table of contents: sticky "On this page" dropdown (hidden from lg up). */}
          <MobileTableOfContents items={tocItems} />

          {/* Table of contents (desktop only).
              Not wrapped in <Reveal>: it is always on screen, and the scroll-in
              animation made it fade out during fast navigation.
              max-h keeps it inside the viewport below the navbar; if it is ever
              taller, it scrolls inside the menu. dvh avoids mobile browser-bar jumps. */}
          <aside className="hidden w-[300px] shrink-0 lg:sticky lg:top-28 lg:block lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto lg:overflow-x-hidden">
            <TableOfContents items={tocItems} />
          </aside>

          {/* Section cards */}
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            {SECTIONS.map((section, index) => {
              const Icon = section.icon;
              return (
                // Each section card is wrapped in <Reveal> (no delay, so cards far down
                // the page don't wait; each one animates as it scrolls into view).
                <Reveal key={section.title}>
                  <section
                    id={sectionId(index)}
                    className="flex w-full scroll-mt-32 flex-col gap-5 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px] sm:p-8"
                  >
                    {/* Section header */}
                    <div className="flex items-center gap-4">
                      <div className="flex shrink-0 items-center justify-center rounded-[12px] border border-[#7c3aed]/20 bg-[#7c3aed]/[0.08] p-3">
                        <Icon className="size-5 text-[#7c3aed]" />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <p className="text-[12px] font-bold uppercase text-[#06b6d4]">
                          Section {String(index + 1).padStart(2, '0')}
                        </p>
                        <h2 className="text-[20px] font-extrabold leading-tight text-[#111827]">
                          {section.title}
                        </h2>
                        <p className="text-[13px] text-[#9ca3af]">{section.description}</p>
                      </div>
                    </div>

                    {/* Divider */}
                    <div className="h-px w-full bg-[linear-gradient(90deg,rgba(124,58,237,0.2)_0%,rgba(6,182,212,0.15)_60%,rgba(6,182,212,0)_100%)]" />

                    {/* Section body */}
                    <div className="flex flex-col gap-4">
                      {section.content.map((item, i) => (
                        <ContentBlock key={i} text={item.text} />
                      ))}
                    </div>
                  </section>
                </Reveal>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}