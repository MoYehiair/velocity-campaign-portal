'use client';
import { use, useState } from 'react';
import { LockKeyhole, Layers3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export default function Report({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [report, setReport] = useState<Record<string, string | number> | null>(
      null,
    );
  async function unlock() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'Could not open report');
      setPassword('');
      const read = await fetch(`/api/reports/${encodeURIComponent(token)}`);
      const result = (await read.json()) as Record<string, string | number>;
      if (!read.ok) throw new Error(String(result.error));
      setReport(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="report-page">
      <div className="report-wordmark">
        <Layers3 /> velocity <span>Campaign results</span>
      </div>
      {report ? (
        <>
          <p className="eyebrow">{report.brand}</p>
          <h1>{report.campaign}</h1>
          <p className="muted">
            {report.channel} campaign · Updated{' '}
            {new Date(report.updated_at).toLocaleString()}
          </p>
          <h2>Latest send</h2>
          <div className="metrics-grid">
            {[
              ['Accepted', 'live_accepted'],
              ['Delivered', 'live_delivered'],
              ['Unique opens', 'live_opened'],
            ].map(([label, key]) => (
              <div className="metric" key={key}>
                <p>{label}</p>
                <strong>{Number(report[key] ?? 0).toLocaleString()}</strong>
              </div>
            ))}
          </div>
          <h2>Historical results</h2>
          <div className="metrics-grid">
            {[
              ['Reported sent', 'reported_sent'],
              ['Reported delivered', 'reported_delivered'],
              ['Unique opens in event log', 'unique_opens'],
              ['Unique clicks in event log', 'unique_clicks'],
            ].map(([label, key]) => (
              <div className="metric" key={key}>
                <p>{label}</p>
                <strong>
                  {report[key] === null
                    ? '—'
                    : Number(report[key]).toLocaleString()}
                </strong>
              </div>
            ))}
          </div>
          <p className="method-note">
            Historical reported totals come from the campaign export. Unique
            engagement counts distinct contacts in the event log; that log may
            be incomplete. Latest-send counts come from provider
            acknowledgements and deduplicated delivery reports.
          </p>
        </>
      ) : (
        <div className="report-lock">
          <div className="icon-tile">
            <LockKeyhole />
          </div>
          <h1>A report, just for you.</h1>
          <p className="muted">Enter the password shared with this link.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            <label htmlFor="report-password">
              Report password
              <Input
                id="report-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <Button className="primary" disabled={busy}>
              {busy ? 'Opening…' : 'View results'}
            </Button>
          </form>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
