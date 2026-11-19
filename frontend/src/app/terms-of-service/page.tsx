// src/app/terms-of-service/page.tsx

import { Check, FileCheck } from 'lucide-react';
import TableOfContents, { MobileTableOfContents } from '../../features/privacy-tos/TableOfContents';
// Scroll-in animation wrapper (client component, safe to use in this server page).
import Reveal from '@/components/reveal';

export const metadata = {
  title: 'Terms of Service – Aura',
  description: 'The terms that govern your access to and use of Aura.',
};

type Section = {
  title: string;
  content: string[];
};

// Text copied from the Figma "Aura terms of service" frame.
// Content strings where every line starts with "•" render as a checklist.
const SECTIONS: Section[] = [
  {
    title: 'Acceptance of Terms',
    content: [
      'Welcome to Aura. By accessing or using our resume optimization platform, you agree to be bound by these Terms of Service. If you do not agree, please do not use the service.',
    ],
  },
  {
    title: 'User Accounts',
    content: [
      'You are responsible for maintaining accurate account information and protecting your login credentials.',
      '• You must be at least 18 years old to create an account.\n• You are responsible for all activity that occurs under your account.\n• Notify Aura promptly if you suspect unauthorized access.',
    ],
  },
  {
    title: 'Use of Services',
    content: [
      'Aura provides AI-powered resume analysis, career recommendations, and related tools for your personal, lawful use.',
      '• Service results are recommendations, not guarantees of employment.\n• You may use generated suggestions in your own professional materials.\n• We may improve, update, or discontinue features as the platform evolves.',
    ],
  },
  {
    title: 'Intellectual Property',
    content: [
      'Aura and its licensors own the platform, software, visual design, algorithms, trademarks, and original service content. These Terms grant you a limited, non-exclusive, revocable license to use the service.',
    ],
  },
  {
    title: 'User Content',
    content: [
      'You retain ownership of resumes, profile details, and other materials you upload. You grant Aura a limited license to host, process, and analyze that content solely to provide and improve the services.',
      '• You confirm that you have the right to upload your content.\n• You may download or delete your materials through account controls.\n• Aura will handle personal data in accordance with our Privacy Policy.',
    ],
  },
  {
    title: 'Prohibited Activities',
    content: [
      'You agree not to misuse Aura or interfere with the experience of other users.',
      '• Do not reverse engineer, scrape, or probe the service.\n• Do not upload malicious code, unlawful content, or another person\u2019s private information.\n• Do not impersonate others or use Aura for fraud, spam, or harassment.',
    ],
  },
  {
    title: 'Disclaimers',
    content: [
      'The service is provided \u201cas is\u201d and \u201cas available.\u201d To the fullest extent permitted by law, Aura disclaims all warranties, including fitness for a particular purpose and uninterrupted availability.',
    ],
  },
  {
    title: 'Limitation of Liability',
    content: [
      'To the fullest extent permitted by law, Aura will not be liable for indirect, incidental, special, consequential, or punitive damages, including lost opportunities, profits, or data arising from your use of the service.',
    ],
  },
  {
    title: 'Termination',
    content: [
      'You may stop using Aura at any time. We may suspend or terminate access if you violate these Terms, create risk for other users, or use the service unlawfully. Provisions that should reasonably survive termination will remain in effect.',
    ],
  },
  {
    title: 'Governing Law',
    content: [
      'These Terms are governed by the laws of the State of California, without regard to conflict-of-law principles. Disputes will be resolved in the state or federal courts located in San Francisco, California.',
    ],
  },
  {
    title: 'Changes to Terms',
    content: [
      'We may update these Terms to reflect changes to our services, laws, or business practices. For material updates, we will provide reasonable notice through Aura or by email. Continued use after the effective date means you accept the revised Terms.',
    ],
  },
  {
    title: 'Contact Information',
    content: [
      'For questions about these Terms of Service, please contact the Aura team.',
      '• Email: analyzeaura@gmail.com',
    ],
  },
];

const sectionId = (index: number) => `section-${index + 1}`;

// Content where every line starts with "•" is shown as a checklist (matching
// the Figma bullet style); anything else is rendered as a normal paragraph.
function ContentBlock({ text }: { text: string }) {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const isList = lines.length > 0 && lines.every((line) => line.trim().startsWith('•'));

  if (isList) {
    return (
      <div className="flex flex-col gap-[14px]">
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#7c3aed]/[0.08]">
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

export default function TermsOfServicePage() {
  const tocItems = SECTIONS.map((section, i) => ({
    id: sectionId(i),
    label: `${i + 1}. ${section.title}`,
  }));

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-x-clip bg-[#f0eeff]">
      {/* ───────────── Decorative background ───────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Soft colour orbs */}
        <div className="absolute -left-[220px] -top-[220px] size-[940px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.38)_0%,rgba(167,139,250,0.16)_38%,rgba(167,139,250,0)_70%)]" />
        <div className="absolute -right-[220px] top-[60px] size-[800px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.30)_0%,rgba(34,211,238,0.12)_40%,rgba(34,211,238,0)_70%)]" />
        <div className="absolute left-[calc(50%-250px)] top-[1190px] size-[620px] rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.18)_0%,rgba(251,113,133,0.06)_40%,rgba(251,113,133,0)_70%)]" />
        <div className="absolute left-0 top-[2450px] size-[500px] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.24)_0%,rgba(251,191,36,0.09)_40%,rgba(251,191,36,0)_70%)]" />

        {/* Top accent line */}
        <div className="absolute left-0 top-0 h-[3px] w-full bg-[#7c3aed]" />

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
              Terms of Service
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
            {SECTIONS.map((section, index) => (
              // Each section card is wrapped in <Reveal> (no delay, so cards far down
              // the page animate as soon as they scroll into view).
              <Reveal key={section.title}>
                <section
                  id={sectionId(index)}
                  className="flex w-full scroll-mt-32 flex-col gap-5 rounded-[24px] border-[1.5px] border-white bg-white/[0.79] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.04)] backdrop-blur-[12px] sm:p-8"
                >
                  {/* Section header */}
                  <div className="flex items-center gap-4">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-[#7c3aed]/20 bg-[#7c3aed]/[0.08]">
                      <FileCheck className="size-5 text-[#7c3aed]" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <p className="text-[12px] font-bold uppercase text-[#06b6d4]">
                        Section {String(index + 1).padStart(2, '0')}
                      </p>
                      <h2 className="text-[20px] font-extrabold leading-tight text-[#111827]">
                        {section.title}
                      </h2>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="h-px w-full bg-[linear-gradient(90deg,rgba(124,58,237,0.2)_0%,rgba(6,182,212,0.15)_60%,rgba(6,182,212,0)_100%)]" />

                  {/* Section body */}
                  <div className="flex flex-col gap-[14px]">
                    {section.content.map((text, i) => (
                      <ContentBlock key={i} text={text} />
                    ))}
                  </div>
                </section>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}