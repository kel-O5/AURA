// src/features/dashboard/components/CompanySelector.tsx
'use client';

import { useState, useRef, useEffect, useLayoutEffect, useId, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, Building2, ChevronDown, Check, Plus, Sparkles } from 'lucide-react';

// IT / tech employers offered as suggestions (reference list). The field is
// free-text: anything typed that isn't on this list can still be added.
import { IT_COMPANIES } from '@/features/dashboard/data/itCatalog';

interface CompanySelectorProps {
  selectedCompanies: string[];
  onSelectionChange: (companies: string[]) => void;
  // Locks the field while an analysis is running
  disabled?: boolean;
  label?: string;
  placeholder?: string;
}

// Where the (portaled) dropdown should sit, computed from the field's own
// bounding box rather than CSS `absolute` positioning.
type MenuRect = { top: number; left: number; width: number };

// One row in the dropdown: "Any" (no specific company), a company from the
// reference list, or "add what I typed".
type Option = { kind: 'any' | 'company' | 'custom'; name: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Limits for what can be added.
const MAX_COMPANIES = 10;
const MAX_COMPANY_LENGTH = 40;
// A company name starts with a letter or number, then letters, numbers, spaces and . & ' -
const COMPANY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&'’\-]*$/u;

export default function CompanySelector({
  selectedCompanies,
  onSelectionChange,
  disabled = false,
  label = 'Target Companies',
  placeholder = 'Any company, or type to add',
}: CompanySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuRect, setMenuRect] = useState<MenuRect | null>(null);
  // Portals need `document`, which doesn't exist during SSR.
  const [mounted, setMounted] = useState(false);

  // fieldRef: the chips + input row (positions the menu, outside-click check).
  // menuRef: the portaled dropdown (lives under <body>).
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listId = useId();

  useEffect(() => setMounted(true), []);

  const q = query.trim();
  const lowerQ = q.toLowerCase();

  // Reference companies matching what is typed (selected ones stay visible, ticked)
  const matches = IT_COMPANIES.filter((c) => c.toLowerCase().includes(lowerQ));

  // Offer to add a typed name that is not already in the list or the selection
  const exists = IT_COMPANIES.some((c) => same(c, q)) || selectedCompanies.some((c) => same(c, q));
  const limitReached = selectedCompanies.length >= MAX_COMPANIES;
  const validCustom = q.length <= MAX_COMPANY_LENGTH && COMPANY_NAME_RE.test(q);
  const invalidName = q.length > 0 && !exists && !validCustom;
  const canAddCustom = q.length > 0 && !exists && validCustom && !limitReached;

  // "Any" = no specific company = an empty selection. It is only offered while
  // nothing is typed, so it never gets in the way of searching the list.
  const anySelected = selectedCompanies.length === 0;

  const options: Option[] = [
    ...(q === '' ? [{ kind: 'any' as const, name: 'Any' }] : []),
    ...matches.map((name) => ({ kind: 'company' as const, name })),
    ...(canAddCustom ? [{ kind: 'custom' as const, name: q }] : []),
  ];
  const active = options.length > 0 ? Math.min(activeIndex, options.length - 1) : -1;

  const isSelected = (name: string) => selectedCompanies.some((c) => same(c, name));

  const close = () => {
    setIsOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  // Anchors the dropdown just below the field; re-runs on scroll/resize while
  // open. Portaled into <body> because the Upload card's `backdrop-blur`
  // creates a stacking context that would otherwise hide the menu under later cards.
  const updateMenuRect = () => {
    const el = fieldRef.current;
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
  }, [isOpen, selectedCompanies.length]);

  // Keep the keyboard-highlighted row visible in the scrolling list
  useEffect(() => {
    if (!isOpen || active < 0) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, isOpen, listId]);

  const openMenu = () => {
    if (!disabled) setIsOpen(true);
  };

  const removeCompany = (name: string) =>
    onSelectionChange(selectedCompanies.filter((c) => !same(c, name)));

  // Multi-select: picking a company toggles it; the menu stays open
  const toggleCompany = (name: string) => {
    if (isSelected(name)) removeCompany(name);
    else if (!limitReached) onSelectionChange([...selectedCompanies, name]);
  };

  const addCustom = (name: string) => {
    const value = name.trim();
    if (!value || isSelected(value) || limitReached) return;
    if (value.length > MAX_COMPANY_LENGTH || !COMPANY_NAME_RE.test(value)) return;
    // Use the list's own spelling when the typed text matches a reference company
    const canonical = IT_COMPANIES.find((c) => same(c, value)) ?? value;
    onSelectionChange([...selectedCompanies, canonical]);
  };

  const choose = (option: Option, viaKeyboard = false) => {
    if (option.kind === 'any') {
      // Clears every selected company; leaving the field empty means "Any".
      onSelectionChange([]);
      close();
      return;
    }
    if (option.kind === 'custom') addCustom(option.name);
    // Typing an already-selected company and pressing Enter keeps it (no duplicate, no removal).
    else if (viaKeyboard && q && isSelected(option.name)) {
      // already selected: nothing to do
    } else toggleCompany(option.name);
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu();
      if (options.length > 0) setActiveIndex((active + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu();
      if (options.length > 0) setActiveIndex((active - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && active >= 0) choose(options[active], true);
    } else if (e.key === ',') {
      // Comma commits whatever was typed as its own company
      e.preventDefault();
      if (q) {
        const exact = IT_COMPANIES.find((c) => same(c, q));
        if (exact && !isSelected(exact)) {
          if (!limitReached) onSelectionChange([...selectedCompanies, exact]);
        }
        else if (!exact) addCustom(q);
        setQuery('');
        setActiveIndex(0);
      }
    } else if (e.key === 'Backspace' && query === '' && selectedCompanies.length > 0) {
      removeCompany(selectedCompanies[selectedCompanies.length - 1]);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  // Close on a click outside the field or the (portaled) menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (fieldRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setIsOpen(false);
      setQuery('');
      setActiveIndex(0);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // If the field gets locked while open, close it
  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
      setQuery('');
    }
  }, [disabled]);

  return (
    <div className="flex min-w-0 flex-col gap-[6px] sm:w-1/2">
      <label id={labelId} className="text-left text-[13px] font-semibold text-[#4b5563]">
        {label}
      </label>

      <div className="relative">
        {/* Field: selected companies as removable chips + an inline text input */}
        <div
          ref={fieldRef}
          onClick={() => {
            if (disabled) return;
            inputRef.current?.focus();
            openMenu();
          }}
          className={`flex min-h-[46px] w-full cursor-text flex-wrap items-center gap-2 rounded-[10px] border bg-white px-[14px] py-[7px] shadow-[0_1px_1.5px_rgba(17,24,39,0.04)] transition ${
            isOpen ? 'border-[#7c3aed] ring-2 ring-[#7c3aed]/15' : 'border-[#e5e7eb]'
          } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          {selectedCompanies.length === 0 && !isOpen && (
            <Building2 aria-hidden className="size-4 shrink-0 text-[#9ca3af]" />
          )}

          {selectedCompanies.map((company) => (
            <span
              key={company}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-[#8b5cf6]/20 bg-[#8b5cf6]/10 px-[10px] py-[3px] text-[13px] font-medium text-[#7c3aed]"
            >
              {/* Long names are cut with "..." so the remove button is always visible */}
              <span className="min-w-0 truncate" title={company}>
                {company}
              </span>
              <button
                type="button"
                aria-label={`Remove ${company}`}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  removeCompany(company);
                }}
                className="shrink-0 text-[#7c3aed]/60 hover:text-[#7c3aed] disabled:cursor-not-allowed"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}

          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            name="target-companies-field"
            value={query}
            maxLength={MAX_COMPANY_LENGTH}
            disabled={disabled}
            placeholder={selectedCompanies.length === 0 ? placeholder : 'Add another…'}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
              openMenu();
            }}
            onFocus={openMenu}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-labelledby={labelId}
            aria-expanded={isOpen}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={isOpen && active >= 0 ? `${listId}-opt-${active}` : undefined}
            className="min-w-[120px] flex-1 bg-transparent py-[3px] text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af] disabled:cursor-not-allowed"
          />

          {/* Arrow toggles the full list without typing */}
          <button
            type="button"
            tabIndex={-1}
            aria-label={isOpen ? 'Hide company suggestions' : 'Show company suggestions'}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (isOpen) close();
              else {
                inputRef.current?.focus();
                openMenu();
              }
            }}
            className="disabled:cursor-not-allowed"
          >
            <ChevronDown
              className={`size-4 shrink-0 text-[#9ca3af] transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {mounted &&
          createPortal(
            <AnimatePresence>
              {isOpen && menuRect && (
                <motion.div
                  ref={menuRef}
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
                  className="z-[999] overflow-hidden rounded-[12px] border border-[#e5e7eb] bg-white shadow-[0_16px_32px_rgba(17,24,39,0.12)]"
                >
                  <div
                    id={listId}
                    role="listbox"
                    aria-multiselectable="true"
                    className="max-h-64 overflow-y-auto py-2"
                  >
                    {options.map((option, index) => {
                      const selected =
                        option.kind === 'any'
                          ? anySelected
                          : option.kind === 'company' && isSelected(option.name);
                      const highlighted = index === active;

                      return (
                        <div key={`${option.kind}-${option.name}`}>
                        <button
                          id={`${listId}-opt-${index}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          // Keep focus in the input while clicking rows
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => choose(option)}
                          className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-[13px] transition-colors ${
                            highlighted ? 'bg-[#7c3aed]/[0.05]' : ''
                          } ${
                            option.kind === 'custom' || option.kind === 'any'
                              ? option.kind === 'any' && !selected
                                ? 'text-[#4b5563]'
                                : 'font-semibold text-[#7c3aed]'
                              : selected
                                ? 'font-semibold text-[#7c3aed]'
                                : 'text-[#4b5563]'
                          }`}
                        >
                          {option.kind === 'any' ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <Sparkles className="size-3.5 shrink-0 text-[#9ca3af]" />
                              <span className="truncate">Any (no specific company)</span>
                            </span>
                          ) : option.kind === 'custom' ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <Plus className="size-4 shrink-0" />
                              <span className="truncate">Add &ldquo;{option.name}&rdquo;</span>
                            </span>
                          ) : (
                            <span className="flex min-w-0 items-center gap-2">
                              <Building2 className="size-3.5 shrink-0 text-[#9ca3af]" />
                              <span className="truncate">{option.name}</span>
                            </span>
                          )}
                          {/* Same checkbox as the Target Job Title list ("Add ..." rows have none) */}
                          {option.kind !== 'custom' && (
                            <span
                              aria-hidden
                              className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                                selected
                                  ? 'border-[#7c3aed] bg-[#7c3aed] text-white'
                                  : 'border-[#d1d5db] bg-white'
                              }`}
                            >
                              {selected && <Check className="size-3" strokeWidth={3} />}
                            </span>
                          )}
                        </button>
                        {option.kind === 'any' && <div className="mx-4 my-1 h-px bg-[#e5e7eb]" />}
                        </div>
                      );
                    })}

                    {invalidName && (
                      <p role="alert" className="px-4 py-2 text-[12px] font-medium text-[#ef4444]">
                        Company names can only use letters, numbers, spaces and . &amp; &apos; -
                      </p>
                    )}
                    {options.length === 0 && !invalidName && (
                      <p className="px-4 py-2 text-[13px] text-[#9ca3af]">No companies found</p>
                    )}
                  </div>

                  <p className="border-t border-[#f3f4f6] px-4 py-2 text-[11px] text-[#9ca3af]">
                    {limitReached
                      ? `Maximum of ${MAX_COMPANIES} companies reached. Remove one to add another.`
                      : 'Select several, or type a name and press Enter. Backspace removes the last one.'}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>,
            document.body
          )}
      </div>
    </div>
  );
}