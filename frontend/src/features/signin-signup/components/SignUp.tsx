// src/features/signin-signup/components/SignUp.tsx
//
// Sign-up flow: email/password/name -> POST /api/auth/signup ->
// if Supabase requires email confirmation, show the OTP step -> POST
// /api/auth/verify-signup-otp -> save session -> redirect.
//
// If email confirmation is OFF in Supabase (Auth > Providers > Email),
// /api/auth/signup returns a session immediately and the OTP step is
// skipped entirely.
//
// CHANGED:
//  - Name fields only accept Latin letters (+ spaces, hyphens, apostrophes).
//  - Email/password show "Invalid email", "Invalid password", or both.
//  - Google / GitHub buttons are on this page (below the Create Account button).
//  - Middle name is optional; only validated when filled in.
//  - Every other field is marked required (red *), and the Terms of Service /
//    Privacy Policy checkbox must be ticked before Create Account or the
//    Google / GitHub buttons will go ahead.
//  - Arriving from a Google/GitHub sign-in with no account
//    (/signup?email=...&name=...&provider=...) prefills the form.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { getAssuranceLevel, getStoredUser, saveSession } from '@/lib/auth';
import { getPasswordPolicyError, PASSWORD_POLICY_MESSAGE } from '@/lib/passwordPolicy';
import AuthShell, { GRADIENT_BG } from './AuthShell';
import OtpVerification from './OtpVerification';

// Strict email check: local part is letters/digits with . _ % + - between them
// (no "=====@gmail.com", no leading/trailing/double dots); domain has real
// labels and a letters-only TLD of 2+ characters.
const EMAIL_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const isValidEmail = (value: string) => EMAIL_RE.test(value) && !value.includes('..');

// FastAPI sends `detail` as a string for our errors but as a list of objects for
// validation errors (which printed "[object Object]"). Always return a string.
const detailMessage = (detail: unknown, fallback: string) =>
  typeof detail === 'string' && detail.trim() ? detail : fallback;

// Names: Latin letters only (accents such as ñ and é are fine), in words
// separated by ONE space, hyphen or apostrophe. No digits, periods or other
// symbols, and no non-Latin scripts (Japanese, Baybayin, ...). Combining marks
// are only allowed from the Latin accent block (U+0300-U+036F), so Baybayin's
// pamudpod (U+1714) and similar marks are rejected.
const LATIN_LETTER = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F';
const NAME_ALLOWED_CHARS_RE = new RegExp(`[^${LATIN_LETTER}\\u0300-\\u036F '’-]`, 'g');
const NAME_WORD = `[${LATIN_LETTER}][\\u0300-\\u036F]*`;
const NAME_RE = new RegExp(`^(?:${NAME_WORD})+(?:[ '’-](?:${NAME_WORD})+)*$`);
const NAME_MAX_LENGTH = 20;
const NAME_FORMAT_MESSAGE = 'Letters only (spaces, hyphens and apostrophes are allowed)';

// The Terms / Privacy links open in the SAME tab, so the typed name and email are
// kept for the trip (never the password) and restored when you come back.
const DRAFT_KEY = 'aura_signup_draft';

// ADDED: hover lift for buttons (no lift while disabled, respects reduced motion).
const BTN_MOTION =
  'transition-all duration-200 ease-out hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 disabled:hover:translate-y-0';

const TERMS_REQUIRED_MESSAGE = 'You must agree to the Terms of Service and Privacy Policy to continue';

// Red asterisk shown after the label of every required field.
function RequiredMark() {
  return (
    <span className="text-[#ef4444]" aria-hidden="true">
      *
    </span>
  );
}

type Step = 'form' | 'otp';
type Provider = 'google' | 'github';

const inputWrapperClass = (hasError: boolean) =>
  [
    'flex w-full items-center gap-2 rounded-[10px] border bg-white px-[14px] py-[12px] transition',
    hasError
      ? 'border-[#ef4444] focus-within:ring-2 focus-within:ring-[#ef4444]/15'
      : 'border-[#e5e7eb] focus-within:border-[#7c3aed] focus-within:ring-2 focus-within:ring-[#7c3aed]/15',
  ].join(' ');

const validateName = (label: string, value: string, optional = false): string | null => {
  const v = value.trim();
  if (!v) return optional ? null : `${label} is required`;
  if (v.length > NAME_MAX_LENGTH) return `${label} is too long`;
  if (!NAME_RE.test(v)) return NAME_FORMAT_MESSAGE;
  return null;
};

async function resendSignupOtp(email: string) {
  const res = await fetch('/api/auth/resend-signup-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(detailMessage(data.detail, 'Could not resend the code. Please try again.'));
  }
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.94H1.28v3.09A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.3a7.2 7.2 0 0 1 0-4.6V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61L5.29 9.7C6.23 6.88 8.88 4.77 12 4.77z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true" fill="#111827">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

export default function SignUp() {
  const [step, setStep] = useState<Step>('form');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Terms of Service / Privacy Policy checkbox (not saved in the draft: it must be
  // ticked again after coming back from reading them).
  const [agreed, setAgreed] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

  const [firstNameError, setFirstNameError] = useState<string | null>(null);
  const [middleNameError, setMiddleNameError] = useState<string | null>(null);
  const [lastNameError, setLastNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // True when the email came from a Google/GitHub sign-in (shown read-only).
  const [emailLocked, setEmailLocked] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<Provider | null>(null);
  const router = useRouter();

  // Already signed in? Skip this page (2FA-pending sessions go to the 2FA step).
  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) return;
    const needsMfa = stored.mfa_enabled && getAssuranceLevel() !== 'aal2';
    router.replace(needsMfa ? '/mfa-challenge' : '/dashboard');
  }, [router]);

  // Prefill from the "no account found" redirect after a Google/GitHub sign-in.
  // Read from window.location (not useSearchParams) so this component needs no
  // Suspense boundary.
  useEffect(() => {
    // Coming back from the Terms / Privacy pages: restore what was typed.
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        setFirstName(String(draft.firstName ?? ''));
        setMiddleName(String(draft.middleName ?? ''));
        setLastName(String(draft.lastName ?? ''));
        setEmail(String(draft.email ?? ''));
        sessionStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      // Ignore a missing or damaged draft.
    }

    const params = new URLSearchParams(window.location.search);
    const prefillEmail = (params.get('email') || '').trim();
    const prefillName = (params.get('name') || '').replace(NAME_ALLOWED_CHARS_RE, ' ').trim();
    const provider = params.get('provider');

    if (prefillEmail && isValidEmail(prefillEmail)) setEmail(prefillEmail);

    if (prefillName) {
      const parts = prefillName.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        setFirstName(parts[0].slice(0, NAME_MAX_LENGTH));
      } else if (parts.length > 1) {
        setFirstName(parts.slice(0, -1).join(' ').slice(0, NAME_MAX_LENGTH));
        setLastName(parts[parts.length - 1].slice(0, NAME_MAX_LENGTH));
      }
    }

    if (prefillEmail) {
      const via = provider === 'github' ? 'GitHub' : provider === 'google' ? 'Google' : 'your account';
      const fromSignIn = params.get('intent') !== 'signup';
      setEmailLocked(isValidEmail(prefillEmail));
      setNotice(
        (fromSignIn
          ? `No Aura account exists yet for the email on ${via === 'your account' ? via : `your ${via} account`}. `
          : `You chose ${via === 'your account' ? 'to sign up' : `to sign up with ${via}`}. `) +
          `Complete the form below to create your account. We will send a 6-digit verification code to ${prefillEmail}.`
      );
    }

    // Clean the address bar so the email is not left in the URL / history.
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const saveDraft = () => {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ firstName, middleName, lastName, email })
      );
    } catch {
      // Storage unavailable: the form simply starts empty when you come back.
    }
  };

  const handleNameChange = (
    value: string,
    setValue: (v: string) => void,
    setFieldError: (v: string | null) => void
  ) => {
    const stripped = value.replace(NAME_ALLOWED_CHARS_RE, '');
    // No leading separator and no two separators in a row ("' '" -> "'").
    const cleaned = stripped
      .replace(/^[ '’\-\u0300-\u036F]+/, '')
      .replace(/([ '’-])[ '’-]+/g, '$1')
      .slice(0, NAME_MAX_LENGTH);
    setValue(cleaned);
    // Show the format hint when disallowed characters were typed/pasted.
    setFieldError(stripped !== value ? NAME_FORMAT_MESSAGE : null);
    if (error) setError(null);
  };

  // Blocks Google / GitHub sign-up until the Terms checkbox is ticked.
  const requireTerms = (): boolean => {
    if (agreed) return true;
    setTermsError(TERMS_REQUIRED_MESSAGE);
    const box = document.getElementById('signup-terms');
    box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box?.focus({ preventScroll: true });
    return false;
  };

  const handleOAuth = async (provider: Provider) => {
    if (oauthLoading || isSubmitting) return;
    if (!requireTerms()) return;
    setError(null);
    setOauthLoading(provider);
    try {
      const res = await fetch(`/api/auth/oauth/${provider}/url`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(detailMessage(data.detail, 'Could not start sign-up with that provider. Please try again.'));
      }
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
      setOauthLoading(null);
    }
  };

  const handleSubmit = async () => {
    const nextFirstNameError = validateName('First name', firstName);
    const nextMiddleNameError = validateName('Middle name', middleName, true);
    const nextLastNameError = validateName('Last name', lastName);

    const emailInvalid = !email.trim() || !isValidEmail(email.trim());
    const passwordPolicyError = password ? getPasswordPolicyError(password) : null;
    const passwordInvalid = !password || !!passwordPolicyError;

    const nextEmailError = !email.trim() ? 'Email is required' : emailInvalid ? 'Invalid email' : null;
    const nextPasswordError = !password ? 'Password is required' : passwordPolicyError ? 'Invalid password' : null;
    const nextConfirmError = !confirm
      ? 'Please confirm your password'
      : confirm !== password
        ? 'Passwords do not match'
        : null;

    setFirstNameError(nextFirstNameError);
    setMiddleNameError(nextMiddleNameError);
    setLastNameError(nextLastNameError);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    const nextTermsError = agreed ? null : TERMS_REQUIRED_MESSAGE;
    setTermsError(nextTermsError);

    // Top message: empty form -> ask to fill it in; both filled but both bad ->
    // "Invalid email and password". Otherwise the field messages are enough.
    const allEmpty =
      !firstName.trim() && !lastName.trim() && !email.trim() && !password && !confirm;
    setError(
      allEmpty
        ? 'Please fill in all required fields'
        : email.trim() && password && emailInvalid && passwordInvalid
          ? 'Invalid email and password'
          : null
    );

    const fieldsInvalid =
      nextFirstNameError ||
      nextMiddleNameError ||
      nextLastNameError ||
      nextEmailError ||
      nextPasswordError ||
      nextConfirmError;
    if (fieldsInvalid || nextTermsError) {
      // Only the checkbox is missing: bring it into view so it is not overlooked.
      if (!fieldsInvalid) {
        const box = document.getElementById('signup-terms');
        box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        box?.focus({ preventScroll: true });
      }
      return;
    }

    // The backend still expects a single `full_name`, so the separate
    // fields are joined here.
    const fullName = [firstName, middleName, lastName]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          full_name: fullName,
          first_name: firstName.trim(),
          middle_name: middleName.trim(),
          last_name: lastName.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(detailMessage(data.detail, 'Could not create your account. Please try again.'));
      }

      if (data.email_confirmation_required) {
        // No session yet — Supabase needs the OTP verified first.
        setStep('otp');
        setIsSubmitting(false);
        return;
      }

      // Email confirmation is disabled on this Supabase project, so a
      // session came back immediately.
      saveSession(data.access_token, data.refresh_token, data.user);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
      setIsSubmitting(false);
    }
  };

  const handleVerifyOtp = async (code: string) => {
    const res = await fetch('/api/auth/verify-signup-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), token: code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(detailMessage(data.detail, 'Invalid or expired code. Please try again.'));
    }

    saveSession(data.access_token, data.refresh_token, data.user);
    router.push('/dashboard');
  };

  return (
    <AuthShell>
      {step === 'form' && (
        <>
          <div className="flex flex-col items-center gap-[6px] text-center">
            <h1 className="text-[28px] font-extrabold leading-tight text-[#111827]">Create Account</h1>
            <p className="text-[14px] text-[#4b5563]">Sign up for your AURA account</p>
          </div>

          {notice && (
            <p
              role="status"
              className="rounded-[10px] border border-[#ddd6fe] bg-[#f5f3ff] px-3 py-2 text-[13px] leading-[1.45] text-[#5b21b6]"
            >
              {notice}
            </p>
          )}

          <form
            noValidate
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <div className="flex flex-col gap-4">
              <p className="text-[12px] text-[#6b7280]">
                Fields marked <span className="text-[#ef4444]">*</span> are required.
              </p>

              {/* First name */}
              <div className="flex flex-col gap-[6px]">
                <label htmlFor="signup-first-name" className="text-[13px] font-semibold text-[#4b5563]">
                  First Name <RequiredMark />
                </label>
                <div className={inputWrapperClass(!!firstNameError)}>
                  <input
                    id="signup-first-name"
                    type="text"
                    autoComplete="given-name"
                    placeholder="Enter your first name"
                    maxLength={NAME_MAX_LENGTH}
                    value={firstName}
                    onChange={(e) => handleNameChange(e.target.value, setFirstName, setFirstNameError)}
                    aria-invalid={!!firstNameError}
                    aria-required="true"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>
                {firstNameError && <p className="text-[12px] font-medium text-[#ef4444]">{firstNameError}</p>}
              </div>

              {/* Middle name */}
              <div className="flex flex-col gap-[6px]">
                <label htmlFor="signup-middle-name" className="text-[13px] font-semibold text-[#4b5563]">
                  Middle Name <span className="font-normal text-[#9ca3af]">(optional)</span>
                </label>
                <div className={inputWrapperClass(!!middleNameError)}>
                  <input
                    id="signup-middle-name"
                    type="text"
                    autoComplete="additional-name"
                    placeholder="Enter your middle name (optional)"
                    maxLength={NAME_MAX_LENGTH}
                    value={middleName}
                    onChange={(e) => handleNameChange(e.target.value, setMiddleName, setMiddleNameError)}
                    aria-invalid={!!middleNameError}
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>
                {middleNameError && <p className="text-[12px] font-medium text-[#ef4444]">{middleNameError}</p>}
              </div>

              {/* Last name */}
              <div className="flex flex-col gap-[6px]">
                <label htmlFor="signup-last-name" className="text-[13px] font-semibold text-[#4b5563]">
                  Last Name <RequiredMark />
                </label>
                <div className={inputWrapperClass(!!lastNameError)}>
                  <input
                    id="signup-last-name"
                    type="text"
                    autoComplete="family-name"
                    placeholder="Enter your last name"
                    maxLength={NAME_MAX_LENGTH}
                    value={lastName}
                    onChange={(e) => handleNameChange(e.target.value, setLastName, setLastNameError)}
                    aria-invalid={!!lastNameError}
                    aria-required="true"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>
                {lastNameError && <p className="text-[12px] font-medium text-[#ef4444]">{lastNameError}</p>}
              </div>

              {/* Email */}
              <div className="flex flex-col gap-[6px]">
                <label htmlFor="signup-email" className="text-[13px] font-semibold text-[#4b5563]">
                  Email <RequiredMark />
                </label>
                <div className={inputWrapperClass(!!emailError)}>
                  <input
                    id="signup-email"
                    readOnly={emailLocked}
                    type="email"
                    autoComplete="email"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailError) setEmailError(null);
                      if (error) setError(null);
                    }}
                    aria-invalid={!!emailError}
                    aria-required="true"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>
                {emailError && <p className="text-[12px] font-medium text-[#ef4444]">{emailError}</p>}
                {emailLocked && (
                  <button
                    type="button"
                    onClick={() => setEmailLocked(false)}
                    className="self-start text-[12px] font-semibold text-[#7c3aed] hover:underline"
                  >
                    Use a different email
                  </button>
                )}
              </div>

              {/* Password */}
              <div className="flex flex-col gap-[6px]">
                <label htmlFor="signup-password" className="text-[13px] font-semibold text-[#4b5563]">
                  Password <RequiredMark />
                </label>
                <div className={inputWrapperClass(!!passwordError)}>
                  <input
                    id="signup-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setPasswordError(null);
                      setConfirmError(null);
                      if (error) setError(null);
                    }}
                    aria-invalid={!!passwordError}
                    aria-required="true"
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
                {passwordError && <p className="text-[12px] font-medium text-[#ef4444]">{passwordError}</p>}
                <p className="text-[12px] text-[#6b7280]">{PASSWORD_POLICY_MESSAGE}</p>
              </div>

              {/* Confirm password */}
              <div className="flex flex-col gap-[6px]">
                <label htmlFor="signup-confirm" className="text-[13px] font-semibold text-[#4b5563]">
                  Confirm Password <RequiredMark />
                </label>
                <div className={inputWrapperClass(!!confirmError)}>
                  <input
                    id="signup-confirm"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value);
                      setConfirmError(null);
                      if (error) setError(null);
                    }}
                    aria-invalid={!!confirmError}
                    aria-required="true"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>
                {confirmError && <p className="text-[12px] font-medium text-[#ef4444]">{confirmError}</p>}
              </div>

              {error && (
                <p role="alert" className="text-[12px] font-medium text-[#ef4444]">
                  {error}
                </p>
              )}
            </div>

            {/* Terms acknowledgement (REQUIRED checkbox) + Notice at Collection (also covers the Google/GitHub buttons) */}
            <div
              className={`flex flex-col gap-3 rounded-[10px] border bg-white/60 px-3 py-3 text-[12px] leading-[1.5] text-[#4b5563] ${
                termsError ? 'border-[#ef4444]' : 'border-[#e5e7eb]'
              }`}
            >
              <label htmlFor="signup-terms" className="flex cursor-pointer items-start gap-2">
                <input
                  id="signup-terms"
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => {
                    setAgreed(e.target.checked);
                    if (e.target.checked) setTermsError(null);
                  }}
                  aria-required="true"
                  aria-invalid={!!termsError}
                  className="mt-[2px] size-4 shrink-0 cursor-pointer accent-[#7c3aed]"
                />
                <span>
                  I have read and agree to the{' '}
                  <Link
                    href="/terms-of-service?from=signup"
                    onClick={saveDraft}
                    className="font-semibold text-[#7c3aed] hover:underline"
                  >
                    Terms of Service
                  </Link>{' '}
                  and acknowledge the{' '}
                  <Link
                    href="/privacy?from=signup"
                    onClick={saveDraft}
                    className="font-semibold text-[#7c3aed] hover:underline"
                  >
                    Privacy Policy
                  </Link>
                  . <RequiredMark />
                </span>
              </label>
              {termsError && (
                <p role="alert" className="text-[12px] font-medium text-[#ef4444]">
                  {termsError}
                </p>
              )}
              <p>
                <span className="font-semibold text-[#111827]">Notice at Collection:</span> we collect
                your name and email to create your account, and the resumes you upload (with your
                target job and companies) to analyze them. See the Privacy Policy for how this
                information is used, stored and shared, and your rights.
              </p>
            </div>

            {/* CHANGED: `transition` -> BTN_MOTION (hover lift) */}
            <button
              type="submit"
              disabled={isSubmitting || !!oauthLoading}
              className={`flex w-full items-center justify-center gap-2 rounded-full ${GRADIENT_BG} px-8 py-[14px] text-[15px] font-bold text-white shadow-[0_2px_3px_rgba(124,58,237,0.1),0_8px_12px_rgba(124,58,237,0.25)] ${BTN_MOTION} hover:brightness-105 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-[18px] animate-spin" />
                  Creating account...
                </>
              ) : (
                'Create Account'
              )}
            </button>
          </form>

          <div className="flex items-center gap-3 text-[12px] font-medium text-[#9ca3af]">
            <span className="h-px flex-1 bg-[#e5e7eb]" />
            or continue with
            <span className="h-px flex-1 bg-[#e5e7eb]" />
          </div>

          {/* Google / GitHub sign-up */}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => handleOAuth('google')}
              disabled={!!oauthLoading || isSubmitting}
              className={`flex w-full items-center justify-center gap-3 rounded-full border border-[#e5e7eb] bg-white px-6 py-[12px] text-[14px] font-semibold text-[#111827] ${BTN_MOTION} hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {oauthLoading === 'google' ? <Loader2 className="size-[18px] animate-spin" /> : <GoogleIcon />}
              Continue with Google
            </button>
            <button
              type="button"
              onClick={() => handleOAuth('github')}
              disabled={!!oauthLoading || isSubmitting}
              className={`flex w-full items-center justify-center gap-3 rounded-full border border-[#e5e7eb] bg-white px-6 py-[12px] text-[14px] font-semibold text-[#111827] ${BTN_MOTION} hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {oauthLoading === 'github' ? <Loader2 className="size-[18px] animate-spin" /> : <GitHubIcon />}
              Continue with GitHub
            </button>
          </div>

          <p className="text-center text-[14px] text-[#4b5563]">
            Already have an account?{' '}
            <Link href="/signin" className="font-semibold text-[#7c3aed] hover:text-[#6d28d9] hover:underline">
              Sign In
            </Link>
          </p>
        </>
      )}

      {step === 'otp' && (
        <OtpVerification
          title="Verify Your Email"
          email={email.trim()}
          submitLabel="Verify & Create Account"
          onVerify={handleVerifyOtp}
          onResend={() => resendSignupOtp(email.trim())}
          backLabel="Use a different email"
          onBack={() => setStep('form')}
        />
      )}
    </AuthShell>
  );
}