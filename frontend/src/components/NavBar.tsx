// components/Navbar.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { LogOut, ChevronDown, Menu, X } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { getStoredUser } from '@/lib/auth';

// ADDED: hover lift for buttons (respects reduced motion).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0';

const AUTH_NAV_LINKS = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'History', href: '/analysis-history' },
  { label: 'Settings', href: '/settings' },
];

const PUBLIC_NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'Features', href: '/#features' },
  { label: 'FAQ', href: '/#faq' },
  { label: 'Contact Us', href: '/#contact' },
];

// Sections of the home page (element ids) that the navbar highlights while you scroll.
// Order must match their order on the page, top to bottom.
const HOME_SECTION_IDS = ['features', 'faq', 'contact'];

// Pages that have their own full-screen layout (per the Figma design) and
// must NOT show the top navbar. Add any other auth-flow routes here.
const NAVBAR_HIDDEN_ROUTES = [
  '/signin',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/oauth-callback',
];

// Top navigation bar - shows user menu when authenticated, sign in/up links otherwise.
// If a page passes `isAuthenticated`, that wins; otherwise the stored session decides.
export const Navbar = ({
  isAuthenticated: isAuthenticatedProp,
  onLogout,
}: {
  isAuthenticated?: boolean;
  onLogout?: () => void;
}) => {
  // Controls visibility of the user dropdown menu
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  // Ref used to detect clicks outside the dropdown
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Mobile / zoomed-in menu (the nav links collapse into it below the lg breakpoint)
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  // ADDED: respect the OS "reduce motion" setting (kept up here with the other hooks)
  const reduceMotion = useReducedMotion();

  const [userName, setUserName] = useState('Your Account');
  const [userEmail, setUserEmail] = useState('');
  // null = session not checked yet (prevents a flash of the public navbar)
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  // Which home-page section is being read: 'home' (top of the page) or one of HOME_SECTION_IDS
  const [activeSection, setActiveSection] = useState('home');

  // Read the session on the client (avoids hydration mismatch).
  // Re-runs on navigation so it stays correct after sign in/out.
  useEffect(() => {
    const stored = getStoredUser();
    setHasSession(!!stored);
    if (stored) {
      setUserName(stored.full_name || stored.email || 'Your Account');
      setUserEmail(stored.email || '');
    } else {
      setUserName('Your Account');
      setUserEmail('');
    }
  }, [pathname, isAuthenticatedProp]);

  // Prop wins if a page passes it explicitly; otherwise use the session
  const isAuthenticated = isAuthenticatedProp ?? hasSession === true;
  // We know which navbar to show if the prop was given or the session was checked
  const sessionReady = isAuthenticatedProp !== undefined || hasSession !== null;

  // Generate initials from the user's name (e.g. "John Doe" -> "JD")
  const initials = userName
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  // Close the dropdown / menu when clicking outside of them
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current && !dropdownRef.current.contains(target)) {
        setIsDropdownOpen(false);
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close both menus after navigating, and on Escape.
  useEffect(() => {
    setIsMenuOpen(false);
    setIsDropdownOpen(false);
  }, [pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Scroll-spy for the home page: highlight Home / Features / FAQ / Contact Us
  // depending on which section is currently being read.
  useEffect(() => {
    if (pathname !== '/') return;

    let frame = 0;

    const update = () => {
      const threshold = Math.max(160, window.innerHeight * 0.35);
      let current = 'home';

      // The last section whose top has scrolled past the threshold is the current one
      for (const id of HOME_SECTION_IDS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= threshold) current = id;
      }

      // At the very bottom of the page, the last section counts as current
      const atBottom =
        window.scrollY > 0 &&
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) current = HOME_SECTION_IDS[HOME_SECTION_IDS.length - 1];

      setActiveSection(current);
    };

    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [pathname]);

  // Hide the navbar on auth pages. This must stay *after* all hooks above so
  // the hook order never changes between renders.
  const hideNavbar =
    !!pathname &&
    NAVBAR_HIDDEN_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));

  if (hideNavbar) return null;

  const navLinks = isAuthenticated ? AUTH_NAV_LINKS : PUBLIC_NAV_LINKS;

  // On the home page the section links follow the scroll position;
  // everywhere else a link is active when it matches the current path.
  const isLinkActive = (href: string) => {
    if (pathname === '/') {
      if (href === '/') return activeSection === 'home';
      if (href.startsWith('/#')) return activeSection === href.slice(2);
    }
    return pathname === href;
  };

  return (
    // CHANGED: <nav> -> <motion.nav>. The navbar itself slides down and fades in once on load.
    // It is animated directly (NOT wrapped in <Reveal>): a wrapper with a transform would
    // break `position: fixed`. Only the nav's own transform is animated, so it stays fixed.
    <motion.nav
      initial={reduceMotion ? false : { opacity: 0, y: -24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="fixed top-6 inset-x-4 sm:inset-x-8 lg:inset-x-20 z-50 font-['DM_Sans',_sans-serif]"
    >
      <div className="relative flex items-center justify-between gap-3 rounded-full border border-white bg-white/80 backdrop-blur-[10px] pl-5 pr-3 py-3 sm:pl-6 sm:pr-3.5 sm:py-3.5 shadow-[0px_2px_8px_0px_rgba(31,41,55,0.04),0px_8px_32px_0px_rgba(31,41,55,0.06)]">
        {/* Logo / brand link. The logo file lives in /public (Aura_LogoRaster.png). */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Image src="/Aura_LogoRaster.png" alt="" width={36} height={36} priority />
          <span className="text-[24px] font-bold tracking-tight text-[#111827]">Aura</span>
        </Link>

        {/* Nav links in the middle on wide screens (lg and up). They sit in their own
            flex cell, so a long account name can no longer overlap them. Below lg they
            move into the hamburger menu. */}
        {sessionReady && (
          <div className="hidden lg:flex min-w-0 flex-1 items-center justify-center gap-8 xl:gap-10 whitespace-nowrap text-sm">
            {navLinks.map((link) => {
              const isActive = isLinkActive(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    isActive
                      ? 'font-semibold text-[#111827]'
                      : 'font-medium text-[#4b5563] hover:text-[#111827] transition-colors'
                  }
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        )}

        {!sessionReady ? (
          // Placeholder while the session is being checked, keeps the navbar height stable
          <div className="h-10 w-24 shrink-0" aria-hidden="true" />
        ) : (
          <div className="flex min-w-0 shrink items-center gap-2 sm:gap-3" ref={menuRef}>
            {isAuthenticated ? (
              // Authenticated state: show user avatar with dropdown menu
              <div className="relative min-w-0 shrink" ref={dropdownRef}>
                <button
                  onClick={() => {
                    setIsDropdownOpen(!isDropdownOpen);
                    setIsMenuOpen(false);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={isDropdownOpen}
                  title={userName}
                  className="flex max-w-full min-w-0 items-center gap-2 pl-2 pr-1 py-1 rounded-full hover:bg-black/[0.03] transition-colors"
                >
                  {/* Avatar showing user initials */}
                  <div className="w-8 h-8 shrink-0 bg-gradient-to-r from-[#7c3aed] to-[#06b6d4] rounded-full flex items-center justify-center">
                    <span className="text-white text-xs font-bold">{initials}</span>
                  </div>
                  {/* Long names are cut with "..." instead of stretching the bar */}
                  <span className="hidden sm:block min-w-0 max-w-[9rem] md:max-w-[12rem] truncate text-sm font-semibold text-[#111827]">
                    {userName}
                  </span>
                  <ChevronDown className={`w-4 h-4 shrink-0 text-[#9ca3af] transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {/* Animated dropdown menu with user info and account actions */}
                <AnimatePresence>
                  {isDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      role="menu"
                      className="absolute right-0 mt-3 w-60 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-[0px_15px_40px_0px_rgba(17,24,39,0.12)] border border-white/80 overflow-hidden"
                    >
                      {/* User info header: the name wraps over at most 2 lines */}
                      <div className="p-3 border-b border-[#f3f4f6] bg-[#faf9ff]">
                        <p className="line-clamp-2 break-words [overflow-wrap:anywhere] text-sm font-bold text-[#111827]">
                          {userName}
                        </p>
                        <p className="truncate text-xs text-[#9ca3af]">{userEmail}</p>
                      </div>

                      {/* Logout action */}
                      <div className="py-2">
                        <button
                          onClick={() => {
                            setIsDropdownOpen(false);
                            setHasSession(false);
                            onLogout?.();
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-red-50 transition-colors flex items-center gap-3"
                        >
                          <LogOut className="w-4 h-4" />
                          Log Out
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              // Unauthenticated state: Sign In / Get Started (inside the menu on phones)
              <div className="hidden sm:flex items-center gap-4 shrink-0">
                <Link href="/signin" className="text-sm font-semibold text-[#4b5563] hover:text-[#111827] transition-colors">
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className={`px-[22px] py-[11px] bg-[#111827] text-white rounded-full text-sm font-semibold hover:opacity-90 ${BTN_MOTION} drop-shadow-[0px_4px_6px_rgba(17,24,39,0.1)]`}
                >
                  Get Started
                </Link>
              </div>
            )}

            {/* Hamburger: shown below lg, where the centered links no longer fit */}
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(!isMenuOpen);
                setIsDropdownOpen(false);
              }}
              aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={isMenuOpen}
              className="lg:hidden flex size-10 shrink-0 items-center justify-center rounded-full text-[#111827] hover:bg-black/[0.05] transition-colors"
            >
              {isMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>

            {/* Mobile / zoomed-in menu panel */}
            <AnimatePresence>
              {isMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="lg:hidden absolute inset-x-0 top-full mt-3 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-3xl border border-white/80 bg-white p-2 shadow-[0px_15px_40px_0px_rgba(17,24,39,0.12)]"
                >
                  <nav className="flex flex-col" aria-label="Main">
                    {navLinks.map((link) => {
                      const isActive = isLinkActive(link.href);
                      return (
                        <Link
                          key={link.href}
                          href={link.href}
                          onClick={() => setIsMenuOpen(false)}
                          className={`rounded-2xl px-4 py-3 text-[15px] ${
                            isActive
                              ? 'bg-[#f5f3ff] font-semibold text-[#6d28d9]'
                              : 'font-medium text-[#374151] hover:bg-[#f9fafb]'
                          }`}
                        >
                          {link.label}
                        </Link>
                      );
                    })}
                    {!isAuthenticated && (
                      <div className="mt-2 flex gap-2 border-t border-[#f3f4f6] p-2 sm:hidden">
                        <Link
                          href="/signin"
                          onClick={() => setIsMenuOpen(false)}
                          className="flex-1 rounded-full border border-[#e5e7eb] px-4 py-2.5 text-center text-sm font-semibold text-[#374151]"
                        >
                          Sign In
                        </Link>
                        <Link
                          href="/signup"
                          onClick={() => setIsMenuOpen(false)}
                          className="flex-1 rounded-full bg-[#111827] px-4 py-2.5 text-center text-sm font-semibold text-white"
                        >
                          Get Started
                        </Link>
                      </div>
                    )}
                  </nav>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </motion.nav>
  );
};