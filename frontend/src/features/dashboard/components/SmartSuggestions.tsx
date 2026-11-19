// src/components/SmartSuggestions.tsx

'use client';

import { motion, useReducedMotion } from 'motion/react';
import { Lightbulb } from 'lucide-react';

type SmartSuggestionsProps = {
  improvements: string[];
  // Dashboard keeps the default; the History results page passes "Priority Improvements".
  title?: string;
};

// Card displaying a list of suggested resume improvements, each marked with a lightbulb icon
export default function SmartSuggestions({
  improvements,
  title = 'Smart Suggestions',
}: SmartSuggestionsProps) {
  // ADDED: respect the OS "reduce motion" setting
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex h-full flex-col gap-4 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px] sm:p-7">
      {/* Header with lightbulb icon and title */}
      <div className="flex items-center gap-2">
        <Lightbulb className="size-[18px] shrink-0 text-[#f59e0b]" />
        <p className="text-[14px] font-bold uppercase text-[#9ca3af]">{title}</p>
      </div>

      {/* List of suggestions */}
      {improvements.length === 0 ? (
        <p className="text-[13px] text-[#4b5563]">No suggestions right now.</p>
      ) : (
        <ul className="flex flex-col gap-[10px]">
          {improvements.map((s, i) => (
            // CHANGED: <li> -> <motion.li>. Each item fades/slides up with a small stagger
            // (capped at 8 steps so a long list doesn't take too long to appear).
            <motion.li
              key={`${s}-${i}`}
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.4,
                delay: reduceMotion ? 0 : Math.min(i, 8) * 0.07,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="flex items-start gap-[10px]"
            >
              <Lightbulb aria-hidden className="mt-[1px] size-[18px] shrink-0 text-[#f59e0b]" />
              <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-[#4b5563]">{s}</span>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}