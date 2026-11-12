// src/features/dashboard/components/upload.tsx

'use client';

import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { FileText, Loader2, UploadCloud, X } from 'lucide-react';

import CompanySelector from './CompanySelector';
import JobTitleSelector from './JobTitleSelector';
import InternshipToggle from './InternshipToggle';

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB, as shown in the Figma copy
const ALLOWED_EXT = /\.(pdf|docx)$/i;

// ADDED: hover lift for buttons (no lift while disabled, respects reduced motion).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 disabled:hover:translate-y-0';

export type UploadPayload = {
  file: File;
  /** Selected job titles joined with ", ". Empty string = "Any". */
  jobTitle: string;
  /** The same titles as a list. Empty array = "Any". */
  jobTitles: string[];
  companies: string;
  /** True = search internship postings only (sent to the API as `internship_only`). */
  internshipOnly?: boolean;
};

type Props = {
  /** Called when the user presses "Upload & Analyze" with a valid file selected. */
  onAnalyze: (payload: UploadPayload) => void | Promise<void>;
  /** Shows the spinner / disables the button while the parent is working. */
  isAnalyzing?: boolean;
  /** Error coming from the parent (e.g. a failed request). */
  error?: string | null;
};

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Upload({ onAnalyze, isAnalyzing = false, error = null }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // Empty array = "Any" job title (no specific role chosen).
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [companies, setCompanies] = useState<string[]>([]);
  const [internshipOnly, setInternshipOnly] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const openPicker = () => {
    if (!isAnalyzing) inputRef.current?.click();
  };

  // Validates and stores the chosen file (from the picker or a drop).
  const acceptFile = (candidate: File | undefined) => {
    if (!candidate) return;

    if (!ALLOWED_EXT.test(candidate.name)) {
      setFile(null);
      setFileError('Unsupported file type. Please upload a PDF or DOCX.');
      return;
    }
    if (candidate.size > MAX_SIZE_BYTES) {
      setFile(null);
      setFileError('That file is too large. The maximum size is 10MB.');
      return;
    }

    setFile(candidate);
    setFileError(null);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (isAnalyzing) return;
    acceptFile(e.dataTransfer.files?.[0]);
  };

  const handleZoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  };

  const clearFile = () => {
    setFile(null);
    setFileError(null);
  };

  const handleSubmit = () => {
    if (!file) {
      setFileError('Please choose a resume to upload.');
      return;
    }
    // Job titles are optional. JobTitleSelector is select-only, so every title in
    // `jobTitles` is already a supported role; an empty list means "Any".
    // The API expects comma-separated strings (same as companies).
    onAnalyze({
      file,
      jobTitle: jobTitles.join(', '),
      jobTitles,
      companies: companies.join(', '),
      internshipOnly,
    });
  };

  const shownError = fileError ?? error;

  return (
    <div className="flex flex-col gap-6 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] px-6 py-8 shadow-[0_15px_40px_rgba(17,24,39,0.04)] backdrop-blur-[12px] sm:px-7">
      {/* Card header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-[20px] font-extrabold leading-tight text-[#111827]">Upload Resume</h2>
        <p className="text-[14px] text-[#4b5563]">
          Upload your resume to generate ATS scoring, keyword recommendations, company matches, and
          formatting insights.
        </p>
      </div>

      {/* Drop zone */}
      <div className="flex flex-1 flex-col gap-2">
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload your resume"
          onClick={openPicker}
          onKeyDown={handleZoneKeyDown}
          onDragOver={(e) => {
            e.preventDefault();
            if (!isAnalyzing) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`flex min-h-[220px] flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-[14px] border-[1.5px] px-4 py-10 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#7c3aed]/30 ${
            isDragging
              ? 'border-solid border-[#7c3aed] bg-[#7c3aed]/[0.06]'
              : 'border-dashed border-[#7c3aed] bg-white/[0.63] hover:bg-white/80'
          } ${isAnalyzing ? 'cursor-not-allowed opacity-70' : ''}`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => {
              acceptFile(e.target.files?.[0]);
              // Reset so choosing the same file again still fires onChange.
              e.target.value = '';
            }}
          />

          {file ? (
            /* Selected-file state */
            <>
              <span className="flex size-12 items-center justify-center rounded-[24px] bg-[#7c3aed]/[0.06]">
                <FileText className="size-6 text-[#7c3aed]" />
              </span>
              <div className="flex w-full max-w-full flex-col items-center gap-1">
                <p className="max-w-full truncate text-[14px] font-semibold text-[#111827]">{file.name}</p>
                <p className="text-[13px] text-[#4b5563]">
                  {formatSize(file.size)} ·{' '}
                  <span className="font-semibold text-[#7c3aed]">click to replace</span>
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  clearFile();
                }}
                disabled={isAnalyzing}
                className="flex items-center gap-1 rounded-full border border-[#e5e7eb] bg-white px-3 py-1 text-[12px] font-medium text-[#4b5563] transition hover:text-[#ef4444] disabled:cursor-not-allowed"
              >
                <X className="size-3" />
                Remove
              </button>
            </>
          ) : (
            /* Empty state (matches Figma) */
            <>
              <span className="flex size-12 items-center justify-center rounded-[24px] bg-[#7c3aed]/[0.06]">
                <UploadCloud className="size-6 text-[#7c3aed]" />
              </span>
              <div className="flex flex-col items-center gap-1">
                <p className="text-[14px] font-semibold text-[#111827]">Upload your resume to begin analysis</p>
                <p className="text-[13px] text-[#4b5563]">
                  or <span className="font-semibold text-[#7c3aed]">click to browse</span>
                </p>
              </div>
              <p className="text-[11px] text-[#9ca3af]">PDF or DOCX files up to 10MB</p>
            </>
          )}
        </div>

        {shownError && (
          <p role="alert" className="text-[12px] font-medium text-[#ef4444]">
            {shownError}
          </p>
        )}
      </div>

      {/* Inputs + CTA */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <JobTitleSelector
            value={jobTitles}
            onChange={(value) => {
              setJobTitles(value);
              setFileError(null);
            }}
            disabled={isAnalyzing}
          />

          <CompanySelector
            selectedCompanies={companies}
            onSelectionChange={setCompanies}
            disabled={isAnalyzing}
          />
        </div>

        {/* Internships-only switch: off = all job types (freelance postings included) */}
        <InternshipToggle checked={internshipOnly} onChange={setInternshipOnly} disabled={isAnalyzing} />

        {/* CHANGED: `transition` -> BTN_MOTION (hover lift) */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isAnalyzing}
          className={`flex w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(90deg,#7c3aed_0%,#a78bfa_60%,#06b6d4_100%)] px-8 py-[14px] text-[15px] font-bold text-white shadow-[0_8px_12px_rgba(124,58,237,0.2)] ${BTN_MOTION} hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="size-[18px] animate-spin" />
              Analyzing...
            </>
          ) : (
            'Upload Resume'
          )}
        </button>
      </div>
    </div>
  );
}