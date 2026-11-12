// src/components/CompanyMatchCarousel.tsx

'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

import {
  Building2,
  ChevronDown,
  MapPin,
  Briefcase,
  Clock,
  DollarSign,
  Users,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react';

// ADDED: hover lift for buttons (no lift while disabled, respects reduced motion).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 disabled:hover:translate-y-0';

export interface CompanyMatch {
  company: string;
  match: number;
  reason: string;
  location: string;
  jobType: string;
  experienceLevel: string;
  salary: string;
  teamSize: string;
  requirements: string[];
  top_job_url?: string;
}

interface CompanyMatchCarouselProps {
  companies: CompanyMatch[];
}

// How many company cards are shown per page.
const PAGE_SIZE = 3;

// Major Philippine cities / business districts a job posting's location
// string is likely to mention (jsearch_client.py builds `location` from
// job_city, job_state, job_country — e.g. "Makati, Metro Manila,
// Philippines" — so a plain substring match against these names works).
const PH_LOCATIONS = [
  'Metro Manila',
  'Manila',
  'Quezon City',
  'Makati',
  'Taguig',
  'BGC',
  'Pasig',
  'Mandaluyong',
  'Pasay',
  'Parañaque',
  'Muntinlupa',
  'San Juan',
  'Cebu City',
  'Davao City',
  'Iloilo City',
  'Bacolod City',
  'Cagayan de Oro',
  'Baguio City',
  'Remote',
];

// The five job types offered in the Job Type filter.
const JOB_TYPE_OPTIONS = ['Full-time', 'Part-time', 'Contractual', 'Freelance', 'Internship'] as const;

// Maps whatever the backend sends (e.g. "Full-time", "FULLTIME", "Part time",
// "CONTRACTOR", "Contract", "Freelancer", "INTERN") onto one of the five options
// above, so the filter still matches when the wording differs. Returns null for
// anything else; those only show under "All Job Types".
function toJobTypeOption(raw: string): (typeof JOB_TYPE_OPTIONS)[number] | null {
  const text = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (text.includes('fulltime')) return 'Full-time';
  if (text.includes('parttime')) return 'Part-time';
  if (text.includes('contract')) return 'Contractual';
  if (text.includes('freelance')) return 'Freelance';
  if (text.startsWith('intern')) return 'Internship'; // "intern", "internship"
  return null;
}

// Labelled dropdown from the Figma filter row (native <select> with a custom chevron)
function FilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-[160px] flex-1 flex-col gap-[6px] sm:w-[180px] sm:flex-none">
      <label htmlFor={id} className="text-[11px] font-bold uppercase text-[#9ca3af]">
        {label}
      </label>

      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full cursor-pointer appearance-none truncate rounded-[10px] border-[1.5px] border-white bg-white/[0.72] py-2 pl-[14px] pr-9 text-[13px] font-medium text-[#111827] shadow-[0_1px_2px_rgba(17,24,39,0.04)] outline-none transition focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15"
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-[14px] top-1/2 size-[14px] -translate-y-1/2 text-[#4b5563]" />
      </div>
    </div>
  );
}

// One "icon + text" pill in the company details row
function DetailPill({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border-[1.5px] border-white bg-white/[0.72] px-3 py-2">
      <Icon className="size-4 shrink-0 text-[#8b5cf6]" />
      <span className="text-[13px] font-medium text-[#4b5563]">{text}</span>
    </div>
  );
}

// Builds a deduped, alphabetized list of the actual values present in the
// analyzed jobs for one field (jobType / experienceLevel). Filter options
// are shown only for values that can actually match something — a fixed
// guess list (e.g. "Full-time"/"Part-time"/"Contract") silently filters
// everything to empty the moment the backend's real strings don't match
// it exactly.
function distinctValues(companies: CompanyMatch[], pick: (c: CompanyMatch) => string): string[] {
  const values = new Set<string>();
  for (const c of companies) {
    const v = pick(c).trim();
    if (v) values.add(v);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

// Card showing the details for one company.
// CHANGED: `index` is the card's position on the page; it drives the stagger delay.
function CompanyCard({ company, index }: { company: CompanyMatch; index: number }) {
  const matchPercent = Math.min(100, Math.max(0, Math.round(company.match)));
  // The backend text can contain "Avg score 38.2/100": show whole numbers only.
  const reasonText = company.reason.replace(/(\d+(?:\.\d+)?)\/100/g, (_m, n) => `${Math.round(parseFloat(n))}/100`);
  const reduceMotion = useReducedMotion();
  const delay = reduceMotion ? 0 : index * 0.12;

  return (
    // CHANGED: slide-in from the right (x: 40) -> fade/slide up with a left-to-right stagger,
    // which fits a 3-column grid. `h-full` makes the 3 cards the same height.
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-full flex-col gap-5 rounded-[16px] border-[1.5px] border-[#8b5cf6]/20 bg-white/[0.72] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px]"
    >
      {/* Company name, match reason, and match score */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <h3
            className="truncate text-[22px] font-black leading-tight text-[#111827]"
            title={company.company}
          >
            {company.company}
          </h3>
          <p className="text-[13px] text-[#4b5563]">{reasonText}</p>
        </div>

        <div className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-[#8b5cf6]/20 bg-[#8b5cf6]/10 px-3 py-2">
          <span className="text-[24px] font-extrabold leading-none text-[#8b5cf6]">
            {matchPercent}%
          </span>
          <span className="text-[10px] font-bold uppercase text-[#9ca3af]">Match Score</span>
        </div>
      </div>

      {/* Visual bar representing the match percentage */}
      <div className="h-[6px] w-full overflow-hidden rounded-full bg-[#7c3aed]/10">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${matchPercent}%` }}
          transition={{ duration: reduceMotion ? 0 : 0.8, delay: delay + 0.2, ease: 'easeOut' }}
          className="h-full rounded-full bg-[linear-gradient(90deg,#8b5cf6_0%,#06b6d4_100%)]"
        />
      </div>

      {/* Job details: location, type, experience, salary, team size */}
      <div className="flex flex-wrap gap-3">
        <DetailPill icon={MapPin} text={company.location} />
        <DetailPill icon={Clock} text={company.jobType} />
        <DetailPill icon={Briefcase} text={company.experienceLevel} />
        <DetailPill icon={DollarSign} text={company.salary} />
        <DetailPill icon={Users} text={`Team: ${company.teamSize}`} />
      </div>

      {/* List of job requirements for this company */}
      <div className="flex flex-col gap-[10px] pt-2">
        <h4 className="text-[11px] font-bold uppercase text-[#9ca3af]">Key Qualifications</h4>

        {company.requirements.map((requirement, index) => (
          <div key={index} className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-[#10b981]" />
            <span className="min-w-0 flex-1 text-[13px] text-[#4b5563]">{requirement}</span>
          </div>
        ))}
      </div>

      {/* Preserved from src1: link is only clickable when a real job URL exists */}
      {company.top_job_url ? (
        // CHANGED: `transition` -> BTN_MOTION (hover lift)
        <a
          href={company.top_job_url}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-auto flex w-full items-center justify-center rounded-full bg-[linear-gradient(90deg,#7c3aed_0%,#a78bfa_60%,#06b6d4_100%)] px-8 py-3 text-[14px] font-bold text-white shadow-[0_8px_12px_rgba(124,58,237,0.2)] ${BTN_MOTION} hover:brightness-105 active:brightness-95`}
        >
          View Full Job Posting
        </a>
      ) : (
        <button
          type="button"
          disabled
          className="mt-auto w-full cursor-not-allowed rounded-full bg-[#7c3aed]/[0.06] px-8 py-3 text-[14px] font-bold text-[#9ca3af]"
        >
          No Job Posting Available
        </button>
      )}
    </motion.div>
  );
}

export default function CompanyMatchCarousel({ companies }: CompanyMatchCarouselProps) {
  // Filter state for location, job type, and experience level
  const [locationFilter, setLocationFilter] = useState('All');
  const [jobTypeFilter, setJobTypeFilter] = useState('All');
  const [experienceLevelFilter, setExperienceLevelFilter] = useState('All');

  // Page of results currently shown (PAGE_SIZE companies per page)
  const [currentPage, setCurrentPage] = useState(0);

  // Job Type uses the fixed list above. Experience Level options come
  // straight from this result's own data, so the dropdown only offers values
  // that can actually match a company.
  const experienceLevelOptions = useMemo(
    () => distinctValues(companies, (c) => c.experienceLevel),
    [companies]
  );

  // A fresh analysis result means the previous filter selections may no
  // longer correspond to anything in the new data — reset to "All"
  // rather than silently showing an empty carousel.
  useEffect(() => {
    setLocationFilter('All');
    setJobTypeFilter('All');
    setExperienceLevelFilter('All');
    setCurrentPage(0);
  }, [companies]);

  // Apply all active filters to the company list
  const filteredCompanies = useMemo(() => {
    return companies.filter((company) => {
      if (locationFilter !== 'All' && !company.location.includes(locationFilter)) return false;

      if (jobTypeFilter !== 'All' && toJobTypeOption(company.jobType) !== jobTypeFilter) return false;

      if (experienceLevelFilter !== 'All' && company.experienceLevel !== experienceLevelFilter)
        return false;

      return true;
    })
      // Best match first, so the list is always in a consistent order.
      .sort((a, b) => b.match - a.match);
  }, [companies, locationFilter, jobTypeFilter, experienceLevelFilter]);

  // The page and companies currently displayed, clamped to the valid range
  const totalPages = Math.max(1, Math.ceil(filteredCompanies.length / PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages - 1);
  const startIndex = activePage * PAGE_SIZE;
  const visibleCompanies = filteredCompanies.slice(startIndex, startIndex + PAGE_SIZE);

  // Changing a filter always starts again from the first page
  const applyFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setCurrentPage(0);
  };

  // Advance to the next page, wrapping around to the start
  const nextPage = () => {
    setCurrentPage((prev) => {
      const page = Math.min(prev, totalPages - 1);
      return page === totalPages - 1 ? 0 : page + 1;
    });
  };

  // Go to the previous page, wrapping around to the end
  const previousPage = () => {
    setCurrentPage((prev) => {
      const page = Math.min(prev, totalPages - 1);
      return page === 0 ? totalPages - 1 : page - 1;
    });
  };

  return (
    <section className="flex flex-col gap-6 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] p-6 shadow-[0_10px_30px_rgba(17,24,39,0.03)] backdrop-blur-[12px] sm:p-8">
      {/* Header */}
      <div className="flex items-center gap-[14px]">
        <div className="flex shrink-0 items-center justify-center rounded-[12px] border border-[#10b981]/20 bg-[#10b981]/10 p-[10px]">
          <Building2 className="size-5 text-[#10b981]" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-[18px] font-bold leading-tight text-[#111827]">Top Company Matches</h2>
          <p className="text-[13px] text-[#4b5563]">
            Companies where your resume has the strongest fit
          </p>
        </div>
      </div>

      {/* Filter controls for location, job type, and experience */}
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="company-filter-location"
          label="Location"
          value={locationFilter}
          onChange={applyFilter(setLocationFilter)}
        >
          <option value="All">All Locations</option>
          {PH_LOCATIONS.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          id="company-filter-job-type"
          label="Job Type"
          value={jobTypeFilter}
          onChange={applyFilter(setJobTypeFilter)}
        >
          <option value="All">All Job Types</option>
          {JOB_TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          id="company-filter-experience"
          label="Experience"
          value={experienceLevelFilter}
          onChange={applyFilter(setExperienceLevelFilter)}
        >
          <option value="All">All Experience</option>
          {experienceLevelOptions.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </FilterSelect>
      </div>

      {/* Show empty state if no companies match the filters */}
      {filteredCompanies.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-[13px] text-[#4b5563]">No companies match your filters</p>
        </div>
      ) : (
        <>
          {/* Up to PAGE_SIZE company cards for the current page.
              CHANGED: 3 columns on large screens, a single column below that. */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {visibleCompanies.map((company, i) => (
              <CompanyCard key={`${company.company}-${startIndex + i}`} company={company} index={i} />
            ))}
          </div>

          {/* Page navigation (wraps around at both ends); hidden when everything fits on one page */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <p className="text-[14px] font-medium text-[#6b737d]">
              Companies {startIndex + 1}-{startIndex + visibleCompanies.length} of{' '}
              {filteredCompanies.length}
            </p>

            {totalPages > 1 && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={previousPage}
                  className={`rounded-[10px] border-[1.5px] border-[#e3e5eb] bg-white/[0.72] px-4 py-[10px] text-[14px] font-medium text-[#6b737d] ${BTN_MOTION} hover:bg-white`}
                >
                  ← Previous
                </button>

                <button
                  type="button"
                  onClick={nextPage}
                  className={`rounded-[10px] bg-[#8b5cf6] px-4 py-[10px] text-[14px] font-bold text-white shadow-[0_4px_12px_rgba(139,92,246,0.3)] ${BTN_MOTION} hover:bg-[#7c3aed]`}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Summary count, shown only while filters are hiding some companies */}
      {filteredCompanies.length !== companies.length && (
        <p className="text-center text-[12px] text-[#9ca3af]">
          Showing {filteredCompanies.length} of {companies.length} companies
        </p>
      )}
    </section>
  );
}