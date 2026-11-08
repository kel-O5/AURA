// src/app/signin/page.tsx
// Sign-in page: email/password login plus Google and GitHub OAuth.
// Talks to the backend via /api/auth/signin and /api/auth/oauth/:provider/url.
//
// CHANGED:
//  - Shows "Invalid email", "Invalid password", or "Invalid email and password".
//  - Wrong credentials from the server show "Invalid email or password" on both
//    fields (the server never says which one was wrong, so account existence
//    is not leaked).
//  - Shows a notice when you were signed out because the session expired.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { DM_Sans } from 'next/font/google';
import { ArrowLeft, Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { getAssuranceLevel, getStoredUser, saveSession } from '@/lib/auth';
import { Footer } from '@/components/Footer';
import Reveal from '@/components/reveal';

// The Figma design uses DM Sans throughout.
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

// Strict email check (no "=====@gmail.com", no double dots, real domain + TLD).
// The backend is the real authority on whether the credentials are valid.
const EMAIL_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const isValidEmail = (value: string) => EMAIL_RE.test(value) && !value.includes('..');

// FastAPI sends `detail` as a string for our errors but as a list of objects for
// validation errors (which printed "[object Object]"). Always return a string.
const detailMessage = (detail: unknown, fallback: string) =>
  typeof detail === 'string' && detail.trim() ? detail : fallback;

// ADDED: hover lift for buttons (no lift while disabled, respects reduced motion).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 disabled:hover:translate-y-0';

// Shared input-wrapper styling (default / focus / error states from Figma).
// The wrapper, not the <input>, draws the border so the show/hide button can sit inside it.
const inputWrapperClass = (hasError: boolean) =>
  [
    'flex w-full items-center gap-2 rounded-[10px] border bg-white px-[14px] py-[12px]',
    'shadow-[0_1px_1.5px_rgba(17,24,39,0.04)] transition',
    hasError
      ? 'border-[#ef4444] focus-within:ring-2 focus-within:ring-[#ef4444]/15'
      : 'border-[#e5e7eb] focus-within:border-[#7c3aed] focus-within:ring-2 focus-within:ring-[#7c3aed]/15',
  ].join(' ');

// Google and GitHub buttons share identical styling.
// CHANGED: `transition` -> BTN_MOTION (hover lift)
const OAUTH_BUTTON_CLASS = `flex min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] border border-[#e5e7eb] bg-white px-4 py-3 text-[14px] font-semibold text-[#4b5563] shadow-[0_1px_1px_rgba(17,24,39,0.02)] ${BTN_MOTION} hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-60`;

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // NOTE: not sent to the backend or read anywhere yet, so it only affects the checkbox UI.
  const [remember, setRemember] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Which OAuth button was clicked (drives its spinner); null when none is in flight.
  const [oauthProvider, setOauthProvider] = useState<'google' | 'github' | null>(null);
  // Form-level error from the API / OAuth start. Field errors are kept separately below.
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // True after the server rejected the credentials: both fields are marked red.
  const [credentialsRejected, setCredentialsRejected] = useState(false);
  // Shown when the session guard sent you here (?reason=expired).
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  // Already signed in? Skip this page (2FA-pending sessions go to the 2FA step).
  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) return;
    const needsMfa = stored.mfa_enabled && getAssuranceLevel() !== 'aal2';
    router.replace(needsMfa ? '/mfa-challenge' : '/dashboard');
  }, [router]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('reason') === 'expired') {
      setNotice('Your session has expired. Please sign in again.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // Disables every submit-type control while any sign-in attempt is running,
  // so the user can't start email and OAuth sign-in at the same time.
  const busy = isSubmitting || oauthProvider !== null;

  const clearErrors = () => {
    setError(null);
    setCredentialsRejected(false);
  };

  const handleSubmit = async () => {
    // Field-level validation
    const emailInvalid = !email.trim() || !isValidEmail(email.trim());
    const passwordInvalid = !password;

    setEmailError(!email.trim() ? 'Email is required' : emailInvalid ? 'Invalid email' : null);
    setPasswordError(passwordInvalid ? 'Password is required' : null);
    setCredentialsRejected(false);
    // Both fields empty -> one message at the top as well.
    setError(!email.trim() && !password ? 'Please enter your email and password' : null);

    if (emailInvalid || passwordInvalid) {
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      // The body may not be JSON on some failures; fall back to an empty object.
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // 400/401 = the backend rejected the credentials. It does not say
        // whether the email or the password was wrong, so neither do we.
        if (res.status === 400 || res.status === 401) {
          if (typeof data.detail === 'string' && /not confirmed/i.test(data.detail)) {
            setError('Please verify your email before signing in.');
          } else {
            setCredentialsRejected(true);
            setError('Invalid email or password');
          }
          setIsSubmitting(false);
          return;
        }
        throw new Error(detailMessage(data.detail, 'Sign in failed. Please try again.'));
      }

      // Persist the session so subsequent authenticated calls (e.g.
      // resume analysis) can send it as a Bearer token.
      saveSession(data.access_token, data.refresh_token, data.user);

      // On success isSubmitting is intentionally left true so the button
      // stays disabled until the navigation completes.
      // Accounts with 2FA only hold a password-level (aal1) session here,
      // which the backend rejects on protected routes until the code is entered.
      router.push(data.mfa_required ? '/mfa-challenge' : '/dashboard');
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
      setIsSubmitting(false);
    }
  };

  // Starts the Supabase OAuth flow: ask our backend for the provider's
  // authorize URL, then send the whole browser window there. This must be a
  // real navigation (not fetch/XHR) so the provider's login page can render.
  // Once the user approves, Supabase redirects back to /oauth-callback with
  // a session in the URL fragment.
  const handleOAuth = async (provider: 'google' | 'github') => {
    clearErrors();
    setOauthProvider(provider);
    try {
      const res = await fetch(`/api/auth/oauth/${provider}/url`);
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.url) {
        throw new Error(data.detail || `Could not start ${provider} sign-in. Please try again.`);
      }

      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
      // Only reset on failure; on success the page is navigating away and the spinner should stay.
      setOauthProvider(null);
    }
  };

  return (
    <div
      className={`${dmSans.className} relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f0eeff]`}
    >
      {/* ───────────── Decorative background ───────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Soft colour orbs */}
        <div className="absolute -left-[220px] -top-[220px] size-[940px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.38)_0%,rgba(167,139,250,0.16)_38%,rgba(167,139,250,0)_70%)]" />
        <div className="absolute -right-[220px] top-[60px] size-[800px] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.30)_0%,rgba(34,211,238,0.12)_40%,rgba(34,211,238,0)_70%)]" />
        <div className="absolute left-[calc(50%-250px)] top-[270px] size-[620px] rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.10)_0%,rgba(251,113,133,0)_70%)]" />
        <div className="absolute -bottom-[200px] left-0 size-[500px] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.22)_0%,rgba(251,191,36,0.08)_40%,rgba(251,191,36,0)_70%)]" />

        {/* Dot grid, kept faint (6% opacity) */}
        <div className="absolute inset-0 bg-[radial-gradient(circle,#7c3aed_1px,transparent_1px)] bg-[length:24px_24px] opacity-[0.06]" />

        {/* Top accent line */}
        <div className="absolute left-0 top-0 h-[3px] w-full bg-[linear-gradient(90deg,#7c3aed_0%,#06b6d4_50%,rgba(139,92,246,0)_100%)]" />

        {/* Decorative rings: top right */}
        <div className="absolute -right-[120px] -top-[120px] size-[340px] rounded-full border border-[#8b5cf6]/20" />
        <div className="absolute -right-[80px] -top-[80px] size-[260px] rounded-full border border-[#8b5cf6]/20" />

        {/* Decorative rings: bottom left */}
        <div className="absolute -bottom-[60px] left-[60px] size-[180px] rounded-full border border-emerald-400/20" />
        <div className="absolute -bottom-[20px] left-[100px] size-[100px] rounded-full border border-emerald-400/20" />
      </div>

      {/* Back to home pill (absolutely positioned so it doesn't push the form down) */}
      <Link
        href="/"
        className="absolute left-4 top-6 z-20 flex items-center gap-2 rounded-full border border-white/80 bg-white/50 px-3 py-2 text-[14px] font-medium text-[#374151] backdrop-blur-[8px] transition hover:bg-white/70 sm:left-20 sm:top-10"
      >
        <ArrowLeft className="size-4" />
        Back to Home
      </Link>

      {/* ───────────── Main content ───────────── */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 pb-16 pt-24 sm:pt-16">
        {/* CHANGED: this wrapper <div> is now a <Reveal> with the same classes, so the
            logo + card fade in together once on load. */}
        <Reveal className="flex w-full max-w-[480px] flex-col items-center gap-5">
          {/* Logo. Same file the Navbar uses (lives in /public). */}
          <Link href="/" className="flex items-center justify-center gap-[12px]">
            <Image src="/Aura_LogoRaster.png" alt="" width={48} height={48} priority />
            <span className="text-[30px] font-bold text-[#111827]">Aura</span>
          </Link>

          {/* Form card */}
          <div className="flex w-full flex-col gap-6 rounded-[24px] border-[1.5px] border-white bg-white/[0.72] px-6 py-9 shadow-[0_4px_16px_rgba(124,58,237,0.05),0_20px_60px_rgba(17,24,39,0.09)] backdrop-blur-[12px] sm:px-10">
            <div className="flex flex-col items-center gap-[6px] text-center">
              <h1 className="text-[28px] font-extrabold leading-tight text-[#111827]">Welcome Back</h1>
              <p className="text-[14px] text-[#4b5563]">Sign in to your AURA account</p>
            </div>

            {notice && (
              <p
                role="status"
                className="rounded-[10px] border border-[#ddd6fe] bg-[#f5f3ff] px-3 py-2 text-center text-[13px] leading-[1.45] text-[#5b21b6]"
              >
                {notice}
              </p>
            )}

            {/* noValidate: use our own error messages instead of the browser's popups */}
            <form
              noValidate
              className="flex flex-col gap-6"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              <div className="flex flex-col gap-4">
                {/* Email */}
                <div className="flex flex-col gap-[6px]">
                  <label htmlFor="signin-email" className="text-[13px] font-semibold text-[#4b5563]">
                    Email
                  </label>
                  <div className={inputWrapperClass(!!emailError || credentialsRejected)}>
                    <input
                      id="signin-email"
                      type="email"
                      autoComplete="email"
                      placeholder="Enter your email"
                      value={email}
                      // Typing clears this field's error and any form-level error.
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (emailError) setEmailError(null);
                        clearErrors();
                      }}
                      aria-invalid={!!emailError || credentialsRejected}
                      aria-describedby={emailError ? 'signin-email-error' : undefined}
                      className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                    />
                  </div>
                  {emailError && (
                    <p id="signin-email-error" className="text-[12px] font-medium text-[#ef4444]">
                      {emailError}
                    </p>
                  )}
                </div>

                {/* Password */}
                <div className="flex flex-col gap-[6px]">
                  <label htmlFor="signin-password" className="text-[13px] font-semibold text-[#4b5563]">
                    Password
                  </label>
                  <div className={inputWrapperClass(!!passwordError || credentialsRejected)}>
                    <input
                      id="signin-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (passwordError) setPasswordError(null);
                        clearErrors();
                      }}
                      aria-invalid={!!passwordError || credentialsRejected}
                      aria-describedby={passwordError ? 'signin-password-error' : undefined}
                      className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="flex-shrink-0 text-[#9ca3af] transition hover:text-[#4b5563]"
                      aria-label="Toggle password visibility"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {passwordError && (
                    <p id="signin-password-error" className="text-[12px] font-medium text-[#ef4444]">
                      {passwordError}
                    </p>
                  )}
                </div>

                {/* API / OAuth / combined error (anything that isn't tied to a single field) */}
                {error && (
                  <p role="alert" className="text-[12px] font-medium text-[#ef4444]">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between">
                {/* Custom checkbox: the real input is visually hidden (sr-only) but stays
                    focusable; the sibling span draws the box and picks up the focus ring via `peer`. */}
                <label className="flex cursor-pointer select-none items-center gap-2">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="peer sr-only"
                  />
                  <span className="flex size-4 items-center justify-center rounded-[4px] border border-[#e5e7eb] bg-white transition peer-focus-visible:ring-2 peer-focus-visible:ring-[#7c3aed]/30">
                    {remember && <Check className="size-[10px] text-[#7c3aed]" strokeWidth={3.5} />}
                  </span>
                  <span className="text-[13px] font-medium text-[#4b5563]">Remember me</span>
                </label>

                <Link
                  href="/forgot-password"
                  className="text-[13px] font-semibold text-[#7c3aed] transition hover:text-[#6d28d9] hover:underline"
                >
                  Forgot Password?
                </Link>
              </div>

              {/* CHANGED: `transition` -> BTN_MOTION (hover lift) */}
              <button
                type="submit"
                disabled={busy}
                className={`flex w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(90deg,#7c3aed_0%,#a78bfa_60%,#06b6d4_100%)] px-8 py-[14px] text-[15px] font-bold text-white shadow-[0_2px_3px_rgba(124,58,237,0.1),0_8px_12px_rgba(124,58,237,0.25)] ${BTN_MOTION} hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-[18px] animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </button>
            </form>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-[#e5e7eb]" />
              <span className="text-[12px] font-medium text-[#9ca3af]">or continue with</span>
              <div className="h-px flex-1 bg-[#e5e7eb]" />
            </div>

            {/* Social login. Each button swaps its logo for a spinner while its own request is running. */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => handleOAuth('google')}
                disabled={busy}
                className={OAUTH_BUTTON_CLASS}
              >
                {oauthProvider === 'google' ? (
                  <Loader2 className="size-[18px] animate-spin" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                )}
                Google
              </button>

              <button
                type="button"
                onClick={() => handleOAuth('github')}
                disabled={busy}
                className={OAUTH_BUTTON_CLASS}
              >
                {oauthProvider === 'github' ? (
                  <Loader2 className="size-[18px] animate-spin" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-[#111827]" aria-hidden>
                    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
                  </svg>
                )}
                GitHub
              </button>
            </div>

            <p className="text-center text-[14px] text-[#4b5563]">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="font-semibold text-[#7c3aed] hover:text-[#6d28d9] hover:underline">
                Sign Up
              </Link>
            </p>
          </div>
        </Reveal>
      </main>

      {/* ───────────── Footer ─────────────
          ConditionalLayout hides the site-wide footer on /signin, so it is
          rendered here instead. The wrapper's z-10 keeps it above the
          decorative background. Footer adds ?from=signin to the legal links itself. */}
      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  );
}