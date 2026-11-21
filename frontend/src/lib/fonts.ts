// src/lib/fonts.ts
//
// The heading ("display") font. Fraunces is a soft, rounded serif, close in feel to the
// heavy serif "AURA" name in the new logo, so headings and the logo match.
// Body text stays DM Sans.
//
// To try another look, change ONE line below, for example:
//   import { Plus_Jakarta_Sans } from 'next/font/google';
//   export const displayFont = Plus_Jakarta_Sans({ subsets: ['latin'], display: 'swap' });
// (also fine: Sora, Playfair_Display, Poppins)

import { Fraunces } from 'next/font/google';

// Variable font: every weight (font-semibold, font-bold, ...) is available.
export const displayFont = Fraunces({ subsets: ['latin'], display: 'swap' });