'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, browserDatabase } from '@/lib/browser';
export default function Callback() {
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        if (!code)
          throw new Error(
            params.get('error_description') ??
              'Google sign-in was not completed',
          );
        const db = await browserDatabase();
        const result = await db.auth.exchangeCodeForSession(code);
        if (result.error) throw result.error;
        try {
          await api('/api/portal?view=membership');
        } catch {
          await db.auth.signOut();
          throw new Error(
            'Your account is not one of the approved brand users.',
          );
        }
        window.location.replace('/portal');
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);
  return (
    <main className="center-page">
      <h1>{error ? 'Unable to sign in' : 'Signing you in…'}</h1>
      {error && (
        <>
          <p role="alert">{error}</p>
          <Link className="primary" href="/">
            Return to sign in
          </Link>
        </>
      )}
    </main>
  );
}
