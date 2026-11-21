// src/components/AuraLogo.tsx
//
// The one place the Aura logo is drawn. The picture (public/Aura_Logo_Full.png) already
// contains the dolphin AND the "AURA" name, so never put separate "Aura" text next to it.
//
// The "AURA" letters are about a third of the picture's height, so the heights below are
// chosen to keep them readable: nav 48/56px tall (letters ~16/19px high), auth 96px (~33px),
// footer 48px (~16px). Need another size? Add it to SIZES or pass a className such as "h-16".

import Image from 'next/image';

const SIZES = {
  nav: 'h-12 sm:h-14',
  auth: 'h-24',
  footer: 'h-12',
} as const;

export default function AuraLogo({
  size = 'nav',
  className = '',
  priority = false,
}: {
  size?: keyof typeof SIZES;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/Aura_Logo_Full.png"
      alt="Aura"
      width={720}
      height={301}
      priority={priority}
      className={`w-auto ${SIZES[size]} ${className}`}
    />
  );
}