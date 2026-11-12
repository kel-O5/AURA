// src/features/dashboard/components/InternshipToggle.tsx
'use client';

import { useId } from 'react';
import { GraduationCap } from 'lucide-react';

// Switch for the Upload form: when on, the form sends `internship_only=true`
// to POST /api/analyze and the backend searches JSearch for internship postings only.

interface InternshipToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  // Locks the field while an analysis is running
  disabled?: boolean;
  label?: string;
  description?: string;
}

export default function InternshipToggle({
  checked,
  onChange,
  disabled = false,
  label = 'Internships only',
  description = 'Show internship postings only. Leave off to see all job types, freelance included.',
}: InternshipToggleProps) {
  const labelId = useId();
  const descId = useId();

  return (
    <div className="flex min-w-0 items-center justify-between gap-4 rounded-[10px] border border-[#e5e7eb] bg-white px-[14px] py-[10px] shadow-[0_1px_1.5px_rgba(17,24,39,0.04)]">
      <div className="flex min-w-0 items-center gap-3">
        <GraduationCap aria-hidden className="size-4 shrink-0 text-[#9ca3af]" />
        <div className="flex min-w-0 flex-col gap-[2px] text-left">
          <span id={labelId} className="text-[13px] font-semibold text-[#4b5563]">
            {label}
          </span>
          <span id={descId} className="text-[12px] text-[#9ca3af]">
            {description}
          </span>
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed]/30 disabled:cursor-not-allowed disabled:opacity-60 ${
          checked ? 'bg-[#7c3aed]' : 'bg-[#e5e7eb]'
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-[2px]'
          }`}
        />
      </button>
    </div>
  );
}