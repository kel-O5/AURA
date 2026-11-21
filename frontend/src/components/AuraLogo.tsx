// src/components/AuraLogo.tsx
//
// The one place the Aura logo is drawn. The picture (public/Aura_Logo_Full.png) already
// contains the dolphin AND the "AURA" name, so never put separate "Aura" text next to it.
//
// HOW TO CHANGE THE SIZE
//   1. Everywhere at once: edit SIZES below (Tailwind height classes:
//      h-10 = 40px, h-12 = 48px, h-14 = 56px, h-16 = 64px, h-20 = 80px, h-24 = 96px, h-28 = 112px).
//   2. One place only: pass a height in pixels, e.g.  <AuraLogo size="auth" height={120} />
// The width always follows automatically, so the logo is never stretched.
//
// The "AURA" letters are about a third of the picture's height, so a 48px logo has letters
// about 16px high. Stay above roughly 44px so the name stays readable.

import Image from 'next/image';

const SIZES = {
  nav: 'h-10 sm:h-12',
  auth: 'h-20',
  footer: 'h-10',
} as const;

export default function AuraLogo({
  size = 'nav',
  height,
  className = '',
  priority = false,
}: {
  size?: keyof typeof SIZES;
  /** Height in pixels. When set it replaces the preset size. */
  height?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/Aura_Logo_Full.png"
      alt="Aura"
      width={700}
      height={280}
      priority={priority}
      style={height ? { height } : undefined}
      className={`w-auto ${height ? '' : SIZES[size]} ${className}`}
    />
  );
}