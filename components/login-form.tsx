'use client';
import { useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { browserDatabase, api } from '@/lib/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export function LoginForm() {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function signIn(google = false) {
    setBusy(true);
    setError('');
    try {
      const db = await browserDatabase();
      if (google) {
        const result = await db.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: `${window.location.origin}/auth/callback` },
        });
        if (result.error) throw result.error;
        return;
      }
      const result = await db.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      try {
        await api('/api/portal?view=membership');
      } catch {
        await db.auth.signOut();
        throw new Error(
          'This account does not have access to a brand workspace.',
        );
      }
      window.location.assign('/portal');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-card">
      <div className="icon-tile">
        <ArrowUpRight />
      </div>
      <p className="eyebrow">WELCOME BACK</p>
      <h2>Sign in to your workspace</h2>
      <p className="muted">Use your approved brand account to continue.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn();
        }}
      >
        <label htmlFor="email">
          Email address
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourbrand.com"
            autoComplete="username"
            required
          />
        </label>
        <label htmlFor="password">
          Password
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="Enter your password"
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="primary">
          {busy ? 'Signing in…' : 'Continue'}
          <ArrowUpRight size={18} />
        </Button>
      </form>
      <div className="divider">or</div>
      <Button
        onClick={() => void signIn(true)}
        disabled={busy}
        variant="outline"
        className="secondary w-full"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M21.8 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.4c2-1.8 2.9-4.5 2.9-7.7ZM12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7A10.4 10.4 0 0 0 12 22ZM6.2 13.6a6.2 6.2 0 0 1 0-3.2V7.7H2.7a10.2 10.2 0 0 0 0 8.6l3.5-2.7ZM12 6.1c1.5 0 2.8.5 3.8 1.5L18.7 5A9.8 9.8 0 0 0 12 2a10.4 10.4 0 0 0-9.3 5.7l3.5 2.7C7 7.9 9.3 6.1 12 6.1Z"
          />
        </svg>
        Continue with Google
      </Button>
      <p className="security-note">
        <ShieldCheck size={16} />
        Access is limited to your brand’s team.
      </p>
    </div>
  );
}
