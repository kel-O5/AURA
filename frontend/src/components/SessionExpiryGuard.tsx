// src/components/SessionExpiryGuard.tsx
//
// The session now ends when the TAB IS CLOSED, not when the user is away.
//
// How: lib/auth.ts keeps the access token in sessionStorage (see ACCESS_TOKEN_KEY),
// and the browser empties sessionStorage when the tab closes. So there is no idle
// timer anymore: a tab left open and unattended stays signed in.
//
// The only thing this component still does (optional, off by default) is react to
// the access token's own expiry date. Leave ENFORCE_TOKEN_EXPIRY = false so an open
// tab is never signed out just because time passed; if the token has expired by the
// time the user clicks something, the API returns 401 and lib/auth.ts clears the
// session as it already does. Set it to true to sign out (with a short warning) the
// moment the token expires, even while the user is away.
//
// Mount it ONCE in the root layout (it renders nothing when signed out).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearSession } from '@/lib/auth';

const ENFORCE_TOKEN_EXPIRY = false;
const WARNING_MS = 60 * 1000; // countdown shown for the last 60 seconds (only if enforcing)

// Same key lib/auth.ts uses for the access token.
const ACCESS_TOKEN_KEY = 'aura_access_token';

function tokenExpiryMs(token: string): number | null {
  try {
    let payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const { exp } = JSON.parse(atob(payload));
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return 0; // unreadable token -> treat as already expired
  }
}

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;

export default function SessionExpiryGuard() {
  const router = useRouter();
  const warningOpen = useRef(false);
  // Seconds left while the warning is showing; null = no warning.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const endSession = useCallback(() => {
    warningOpen.current = false;
    setSecondsLeft(null);
    clearSession();
    router.replace('/signin?reason=expired');
  }, [router]);

  useEffect(() => {
    if (!ENFORCE_TOKEN_EXPIRY) return;

    const tick = () => {
      let token: string | null = null;
      try {
        token = window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
      } catch {
        // Storage unavailable: nothing to guard.
      }
      if (!token) {
        warningOpen.current = false;
        setSecondsLeft((s) => (s === null ? s : null));
        return; // signed out
      }

      const exp = tokenExpiryMs(token);
      if (exp === null) return; // token has no expiry date

      const left = exp - Date.now();
      if (left <= 0) {
        endSession();
      } else if (left <= WARNING_MS) {
        warningOpen.current = true;
        setSecondsLeft(Math.ceil(left / 1000));
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [endSession]);

  if (secondsLeft === null) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 px-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-expiry-title"
        className="w-full max-w-[380px] rounded-2xl bg-white p-6 text-center shadow-xl"
      >
        <h2 id="session-expiry-title" className="text-[20px] font-bold text-[#111827]">
          Your session is about to expire
        </h2>
        <p className="mt-2 text-[14px] leading-[1.45] text-[#4b5563]">
          For your security you will be signed out soon. Please save your work.
        </p>
        <p className="mt-3 text-[28px] font-extrabold tabular-nums text-[#7c3aed]">
          {formatTime(secondsLeft)}
        </p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={endSession}
            className="flex-1 rounded-full border border-[#e5e7eb] bg-white px-4 py-[10px] text-[14px] font-semibold text-[#4b5563] hover:bg-[#f9fafb]"
          >
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}