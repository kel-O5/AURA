// src/features/dashboard/components/JobTitleSelector.tsx
'use client';

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Briefcase, Check, ChevronDown, Sparkles, X } from 'lucide-react';

import { SUPPORTED_JOB_TITLES } from '@/features/dashboard/data/supportedJobs';

// Select-only, multi-select field. The user can NOT type a job title: the only
// values this component can ever produce are roles from SUPPORTED_JOB_TITLES
// (the roles the backend has a skill checklist for, see job_requirements.py).
//
// "Any" is the first row of the list. It means "no specific job title", which is
// exactly an EMPTY array, so choosing Any clears every selected title, and
// choosing a title un-checks Any. Leaving the field untouched is the same as Any.
//
// Keyboard: Arrow Up/Down, Home/End, Enter/Space to toggle a row, Esc to close,
// and typing a letter jumps to the next row starting with it.

const TITLES: readonly string[] = SUPPORTED_JOB_TITLES;

// Row 0 is "Any"; row n (n >= 1) is TITLES[n - 1].
const ANY_LABEL = 'Any';
const ROW_COUNT = TITLES.length + 1;
const rowLabel = (row: number) => (row === 0 ? ANY_LABEL : TITLES[row - 1]);

interface JobTitleSelectorProps {
  /** Selected titles. An empty array means "Any". */
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  placeholder?: string;
  /** Most titles that can be chosen at once. */
  maxSelections?: number;
}

type MenuRect = { top: number; left: number; width: number };

export default function JobTitleSelector({
  value,
  onChange,
  disabled = false,
  id = 'target-job-title',
  label = 'Target Job Title',
  placeholder = 'Any job title',
  maxSelections = 3,
}: JobTitleSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<MenuRect | null>(null);
  // Highlighted row while the list is open (keyboard and hover).
  const [activeIndex, setActiveIndex] = useState(0);
  // Portals need `document`, which doesn't exist during SSR.
  const [mounted, setMounted] = useState(false);

  // wrapperRef: the trigger + clear button together (outside-click detection
  // and menu positioning). menuRef: the portaled list (lives under <body>).
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const selected = value.filter((title) => TITLES.includes(title));
  const hasValue = selected.length > 0;
  const atLimit = selected.length >= maxSelections;

  const close = () => setIsOpen(false);

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(hasValue ? TITLES.indexOf(selected[0]) + 1 : 0);
    setIsOpen(true);
  };

  // Recomputes where the dropdown is drawn, anchored just below the field.
  // Re-runs on scroll/resize while open so it tracks the field.
  //
  // Rendered through a portal into <body> because the Upload card uses
  // `backdrop-blur`, which creates its own CSS stacking context, so nothing
  // nested inside it can paint above sibling cards that come later in the DOM.
  const updateMenuRect = () => {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Field scrolled out of view: close the menu instead of leaving it stuck on screen.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      close();
      return;
    }
    setMenuRect({ top: rect.bottom + 8, left: rect.left, width: rect.width });
  };

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuRect();
    window.addEventListener('scroll', updateMenuRect, true);
    window.addEventListener('resize', updateMenuRect);
    return () => {
      window.removeEventListener('scroll', updateMenuRect, true);
      window.removeEventListener('resize', updateMenuRect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Keep the highlighted row visible when navigating with the keyboard.
  useEffect(() => {
    if (!isOpen || !menuRect) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, activeIndex, menuRect]);

  // Row 0 ("Any") clears the selection; any other row adds or removes that title.
  // The menu stays open after picking a title so several can be chosen in a row.
  const toggleRow = (row: number) => {
    if (row === 0) {
      onChange([]);
      close();
      return;
    }
    const title = TITLES[row - 1];
    if (selected.includes(title)) {
      onChange(selected.filter((t) => t !== title));
    } else if (!atLimit) {
      onChange([...selected, title]);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) openMenu();
        else setActiveIndex((i) => Math.min(i + 1, ROW_COUNT - 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) openMenu();
        else setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      case 'Home':
        if (isOpen) {
          e.preventDefault();
          setActiveIndex(0);
        }
        return;
      case 'End':
        if (isOpen) {
          e.preventDefault();
          setActiveIndex(ROW_COUNT - 1);
        }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!isOpen) openMenu();
        else toggleRow(activeIndex);
        return;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          close();
        }
        return;
      case 'Tab':
        close();
        return;
    }

    // Type-ahead: jump to the next row that starts with the pressed letter.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const base = isOpen ? activeIndex : 0;
      for (let step = 1; step <= ROW_COUNT; step++) {
        const idx = (base + step) % ROW_COUNT;
        if (rowLabel(idx).toLowerCase().startsWith(ch)) {
          e.preventDefault();
          setActiveIndex(idx);
          setIsOpen(true);
          return;
        }
      }
    }
  };

  // Close on a click outside the field or the (portaled) menu.
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  // Safety net: if the parent ever hands in a title that is not on the list (or
  // too many, or duplicates), trim it so an unlisted title can't be submitted.
  useEffect(() => {
    const valid = value
      .filter((title, i) => TITLES.includes(title) && value.indexOf(title) === i)
      .slice(0, maxSelections);
    if (valid.length !== value.length) onChange(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-[#4b5563]">
        {label}
      </label>

      <div ref={wrapperRef} className="relative">
        {/* Trigger: a button, not a text input, so nothing can be typed in. */}
        <button
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={`${id}-listbox`}
          aria-activedescendant={isOpen ? `${id}-option-${activeIndex}` : undefined}
          disabled={disabled}
          title={hasValue ? selected.join(', ') : undefined}
          onClick={() => (isOpen ? close() : openMenu())}
          onKeyDown={handleKeyDown}
          // pr-10 leaves room for the arrow; pr-16 also leaves room for the clear button
          className={`flex w-full items-center gap-2 rounded-[10px] border border-[#e5e7eb] bg-white py-[12px] pl-[14px] text-left text-[14px] shadow-[0_1px_1.5px_rgba(17,24,39,0.04)] outline-none transition focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/15 disabled:cursor-not-allowed disabled:opacity-60 ${
            hasValue ? 'pr-16 text-[#111827]' : 'pr-10 text-[#9ca3af]'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{hasValue ? selected[0] : placeholder}</span>
          {selected.length > 1 && (
            <span className="shrink-0 rounded-full bg-[#7c3aed]/10 px-2 py-0.5 text-[11px] font-semibold text-[#7c3aed]">
              +{selected.length - 1}
            </span>
          )}
        </button>

        {hasValue && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear job titles"
            // Keep focus on the trigger so clicking this doesn't blur it
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange([]);
              close();
            }}
            className="absolute right-[38px] top-1/2 -translate-y-1/2 rounded-full p-0.5 text-[#9ca3af] transition hover:text-[#ef4444]"
          >
            <X className="size-3.5" />
          </button>
        )}

        {/* Dropdown arrow, same icon and look as the Target Companies field */}
        <ChevronDown
          aria-hidden
          className={`pointer-events-none absolute right-[14px] top-1/2 size-4 shrink-0 -translate-y-1/2 text-[#9ca3af] transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />

        {mounted &&
          createPortal(
            <AnimatePresence>
              {isOpen && menuRect && (
                <motion.div
                  ref={menuRef}
                  id={`${id}-listbox`}
                  role="listbox"
                  aria-multiselectable="true"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  style={{
                    position: 'fixed',
                    top: menuRect.top,
                    left: menuRect.left,
                    width: menuRect.width,
                  }}
                  className="z-[999] max-h-64 overflow-y-auto rounded-[12px] border border-[#e5e7eb] bg-white pt-2 shadow-[0_16px_32px_rgba(17,24,39,0.12)]"
                >
                  {Array.from({ length: ROW_COUNT }, (_, row) => {
                    const isAny = row === 0;
                    const title = isAny ? ANY_LABEL : TITLES[row - 1];
                    const checked = isAny ? !hasValue : selected.includes(title);
                    const active = row === activeIndex;
                    // Once the limit is reached, unchecked titles can't be added.
                    const blocked = !isAny && !checked && atLimit;
                    return (
                      <div key={title}>
                        <button
                          id={`${id}-option-${row}`}
                          data-index={row}
                          type="button"
                          role="option"
                          aria-selected={checked}
                          aria-disabled={blocked}
                          onClick={() => toggleRow(row)}
                          onMouseEnter={() => setActiveIndex(row)}
                          className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-[13px] transition-colors ${
                            active ? 'bg-[#7c3aed]/[0.05]' : ''
                          } ${checked ? 'font-semibold text-[#7c3aed]' : 'text-[#4b5563]'} ${
                            blocked ? 'cursor-not-allowed opacity-50' : ''
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {isAny ? (
                              <Sparkles className="size-3.5 shrink-0 text-[#9ca3af]" />
                            ) : (
                              <Briefcase className="size-3.5 shrink-0 text-[#9ca3af]" />
                            )}
                            <span className="truncate">
                              {isAny ? 'Any (no specific job title)' : title}
                            </span>
                          </span>
                          <span
                            aria-hidden
                            className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                              checked
                                ? 'border-[#7c3aed] bg-[#7c3aed] text-white'
                                : 'border-[#d1d5db] bg-white'
                            }`}
                          >
                            {checked && <Check className="size-3" strokeWidth={3} />}
                          </span>
                        </button>
                        {isAny && <div className="mx-4 my-1 h-px bg-[#e5e7eb]" />}
                      </div>
                    );
                  })}

                  {atLimit && (
                    <p className="sticky bottom-0 border-t border-[#e5e7eb] bg-white px-4 py-2 text-[11px] text-[#9ca3af]">
                      You can choose up to {maxSelections} job titles.
                    </p>
                  )}
                  {!atLimit && <div className="h-2" />}
                </motion.div>
              )}
            </AnimatePresence>,
            document.body
          )}
      </div>
    </div>
  );
}