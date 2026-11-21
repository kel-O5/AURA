// src/features/signin-signup/components/AuthShell.tsx
'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { DM_Sans } from 'next/font/google';
import { ArrowLeft } from 'lucide-react';
import { Footer } from '@/components/Footer';
// ADDED: scroll-in animation wrapper (file is src/components/reveal.tsx).
import Reveal from '@/components/reveal';
// Shared logo: the same component the nav bar and sign-in page use, so all logos match.
// Adjust this import to the real location of AuraLogo.tsx if it differs.
import AuraLogo from '@/components/AuraLogo';

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

export const GRADIENT_BG = 'bg-[linear-gradient(90deg,#7c3aed_0%,#a78bfa_60%,#06b6d4_100%)]';

export default function AuthShell({
  children,
  maxWidthClass = 'max-w-[480px]',
}: {
  children: ReactNode;
  maxWidthClass?: string; // full Tailwind class so it gets detected
}) {
  return (
    <div className={`${dmSans.className} relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f0eeff]`}>
      {/* ───────────── Decorative background ───────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Soft colour orbs */}
        <div className="absolute -left-[220px] -top-[220px] size-[940px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.38)_0%,rgba(167,139,250,0.16)_38%,rgba(167,139,250,0)_70%)]" />
        <div className="absolute -right-[220px] top-[60px] size-[800px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.30)_0%,rgba(34,211,238,0.12)_40%,rgba(34,211,238,0)_70%)]" />
        <div className="absolute left-[calc(50%-250px)] top-[270px] size-[620px] rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.10)_0%,rgba(251,113,133,0)_70%)]" />
        <div className="absolute -bottom-[200px] left-0 size-[500px] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.22)_0%,rgba(251,191,36,0.08)_40%,rgba(251,191,36,0)_70%)]" />

        {/* Dot grid, kept faint (6% opacity) */}
        <div className="absolute inset-0 bg-[radial-gradient(circle,#7c3aed_1px,transparent_1px)] bg-[length:24px_24px] opacity-[0.06]" />

        {/* Top accent line */}
        <div className="absolute left-0 top-0 h-[3px] w-full bg-[linear-gradient(90deg,#7c3aed_0%,#06b6d4_50%,rgba(139,92,246,0)_100%)]" />

        {/* Decorative rings: top right */}
        <div className="absolute -right-[120px] -top-[120px] size-[340px] rounded-full border border-[#8b5cf6]/20" />
        <div className="absolute -right-[80px] -top-[80px] size-[260px] rounded-full border border-[#8b5cf6]/20" />

        {/* Decorative rings: bottom left */}
        <div className="absolute -bottom-[60px] left-[60px] size-[180px] rounded-full border border-emerald-400/20" />
        <div className="absolute -bottom-[20px] left-[100px] size-[100px] rounded-full border border-emerald-400/20" />
      </div>

      <Link
        href="/"
        className="absolute left-4 top-6 z-20 flex items-center gap-2 rounded-full border border-white/80 bg-white/50 px-3 py-2 text-[14px] font-medium text-[#374151] backdrop-blur-[8px] transition hover:bg-white/70 sm:left-20 sm:top-10"
      >
        <ArrowLeft className="size-4" />
        Back to Home
      </Link>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 pb-12 pt-24">
        {/* CHANGED: this wrapper <div> is now a <Reveal> with the same classes.
            AuthShell stays mounted while the steps inside it change (form -> otp -> ...),
            so this only plays once, when the page first loads. */}
        <Reveal className={`flex w-full ${maxWidthClass} flex-col items-center gap-5`}>
          {/* Logo + name */}
          {/* The full logo already includes the "AURA" name, so no separate text. */}
          <Link href="/" aria-label="Aura home" className="flex items-center justify-center">
            <AuraLogo size="auth" priority />
          </Link>

          <div className="flex w-full flex-col gap-5 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] px-6 py-8 shadow-[0_4px_16px_rgba(124,58,237,0.05),0_20px_60px_rgba(17,24,39,0.09)] backdrop-blur-[12px] sm:px-10">
            {children}
          </div>
        </Reveal>
      </main>

      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  );
}