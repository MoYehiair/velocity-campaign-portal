'use client';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Mail,
  MessageSquare,
  Send,
  Share2,
  Check,
} from 'lucide-react';
import { api } from '@/lib/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  useRemote,
  LoadState,
  NoData,
  PageControls,
  Status,
  number,
} from './common';
import type { Campaign, Approval, SendJob } from '@/lib/domain/types';
interface CampaignMetrics {
  campaign: Campaign;
  unique_opens: number;
  unique_clicks: number;
  event_count: number;
  historical_sent: number | null;
  live_delivered: number;
  live_opened: number;
  live_bounced: number;
  live_unsubscribed: number;
}
interface Recipients {
  approval: Approval;
  recipients: {
    external_contact_id: string;
    full_name: string;
    destination: string;
  }[];
}
function ApprovalDialog({
  id,
  onClose,
  onSent,
}: {
  id: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const state = useRemote<Recipients>(
    `/api/portal?view=recipients&id=${id}&page=${page}`,
  );
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await api('/api/send/confirm', {
        method: 'POST',
        body: JSON.stringify({ approvalId: id }),
      });
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="campaign-dialog">
        <DialogHeader>
          <DialogTitle>Review your campaign send</DialogTitle>
          <DialogDescription>
            This is the saved audience you are approving. Confirmation queues
            one send.
          </DialogDescription>
        </DialogHeader>
        <LoadState {...state} retry={state.reload} />
        {state.data && (
          <>
            <div className="approval-summary">
              <div>
                <p>{state.data.approval.campaign_name}</p>
                <span>{state.data.approval.channel} campaign</span>
              </div>
              <strong>
                {number(state.data.approval.recipient_count)}
                <small>recipients</small>
              </strong>
            </div>
            <div className="recipient-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Destination</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.recipients.map((r) => (
                    <TableRow key={r.external_contact_id}>
                      <TableCell>
                        {r.full_name}
                        <small>{r.external_contact_id}</small>
                      </TableCell>
                      <TableCell>{r.destination}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PageControls
              page={page}
              total={state.data.approval.recipient_count}
              onChange={setPage}
            />
            <p className="method-note">
              Preview expires at{' '}
              {new Date(state.data.approval.expires_at).toLocaleTimeString()}.
              If consent or contact details change, confirmation is blocked and
              a fresh review is required.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                className="primary"
                onClick={() => void confirm()}
                disabled={busy || !state.data.approval.recipient_count}
              >
                {busy
                  ? 'Confirming…'
                  : `Confirm ${number(state.data.approval.recipient_count)} recipients`}
                <Send size={16} />
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
function ShareDialog({
  campaign,
  onClose,
}: {
  campaign: Campaign;
  onClose: () => void;
}) {
  const [password, setPassword] = useState(''),
    [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ url: string }>('/api/shares', {
        method: 'POST',
        body: JSON.stringify({ campaignId: campaign.external_id, password }),
      });
      setUrl(result.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="share-dialog">
        <DialogHeader>
          <DialogTitle>Share campaign results</DialogTitle>
          <DialogDescription>
            {campaign.campaign_name} · Aggregate results only. Customer
            information stays private.
          </DialogDescription>
        </DialogHeader>
        {url ? (
          <>
            <label htmlFor="created-report-link">
              Report link
              <Input id="created-report-link" readOnly value={url} />
            </label>
            <p className="muted">
              Share this link and the password you chose with your client.
            </p>
            <Button
              onClick={() => {
                void navigator.clipboard
                  .writeText(url)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError('Copy failed. Select and copy the link above.'),
                  );
              }}
            >
              {copied ? <Check /> : <Share2 />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label htmlFor="share-password">
              Set a report password
              <Input
                id="share-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={12}
                maxLength={128}
                required
                autoComplete="new-password"
              />
            </label>
            <p className="muted">Use at least 12 characters.</p>
            <Button className="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create protected link'}
            </Button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
function JobProgress({ job }: { job: SendJob }) {
  const [page, setPage] = useState(0);
  const state = useRemote<{
    rows: {
      id: string;
      batch_number: number;
      status: string;
      provider_batch_id: string | null;
      last_polled_at: string | null;
      poll_error: string | null;
      last_error: string | null;
    }[];
    total: number;
  }>(`/api/portal?view=batches&id=${job.id}&page=${page}`);
  useEffect(() => {
    const interval = setInterval(state.reload, 15000);
    return () => clearInterval(interval);
  }, [state.reload]);
  return (
    <section className="surface">
      <div className="section-heading">
        <div>
          <h2>Send progress</h2>
          <p>Confirmed {new Date(job.created_at).toLocaleString()}</p>
        </div>
        <Status value={job.status} />
      </div>
      <div className="progress-numbers">
        <span>
          <strong>{number(job.accepted_count)}</strong> Accepted
        </span>
        <span>
          <strong>{number(job.rejected_count)}</strong> Rejected
        </span>
      </div>
      {job.last_error && (
        <p className="error" role="alert">
          {job.last_error}
        </p>
      )}
      <LoadState {...state} retry={state.reload} />
      {state.data?.rows.length ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last report check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    {b.batch_number + 1}
                    <small>{b.provider_batch_id ?? 'Awaiting dispatch'}</small>
                  </TableCell>
                  <TableCell>
                    <Status value={b.status} />
                    {(b.last_error || b.poll_error) && (
                      <small className="error">
                        {b.last_error ?? b.poll_error}
                      </small>
                    )}
                  </TableCell>
                  <TableCell>
                    {b.last_polled_at
                      ? new Date(b.last_polled_at).toLocaleString()
                      : 'Not checked yet'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PageControls
            page={page}
            total={state.data.total}
            onChange={setPage}
          />
        </>
      ) : (
        state.data && (
          <p className="method-note">
            The campaign is queued. The background worker will prepare its
            batches.
          </p>
        )
      )}
    </section>
  );
}
export function Campaigns({
  owner,
  selected,
  onSelect,
}: {
  owner: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const list = useRemote<Campaign[]>('/api/portal?view=campaigns');
  return selected ? (
    <CampaignDetail id={selected} owner={owner} onBack={() => onSelect(null)} />
  ) : (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">REACH YOUR AUDIENCE</p>
          <h1>Campaigns</h1>
          <p className="muted">
            Review performance, approve a send, and share the results.
          </p>
        </div>
      </div>
      <LoadState {...list} retry={list.reload} />
      {list.data?.length ? (
        <div className="campaign-grid">
          {list.data.map((c) => (
            <button
              className="campaign-card"
              key={c.external_id}
              onClick={() => onSelect(c.external_id)}
            >
              <div className="campaign-card-top">
                <span className={`campaign-icon ${c.channel}`}>
                  {c.channel === 'email' ? <Mail /> : <MessageSquare />}
                </span>
                <ArrowUpRight size={19} />
              </div>
              <span className="eyebrow">
                {c.external_id} · {c.channel}
              </span>
              <h2>{c.campaign_name}</h2>
              <div className="campaign-card-stats">
                <span>
                  <strong>{number(c.reported_sent)}</strong>Reported sent
                </span>
                <span>
                  <strong>{number(c.reported_delivered)}</strong>Reported
                  delivered
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        list.data && (
          <NoData
            title="No campaigns imported"
            description="Campaigns will appear once your brand’s data is loaded."
          />
        )
      )}
    </>
  );
}
function CampaignDetail({
  id,
  owner,
  onBack,
}: {
  id: string;
  owner: boolean;
  onBack: () => void;
}) {
  const state = useRemote<CampaignMetrics>(
    `/api/portal?view=campaign&id=${encodeURIComponent(id)}`,
  );
  const jobs = useRemote<SendJob[]>('/api/portal?view=jobs');
  const [approval, setApproval] = useState<string | null>(null),
    [sharing, setSharing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const job = jobs.data?.find((j) => j.campaign_external_id === id),
    data = state.data;
  const { reload: reloadJobs } = jobs;
  const { reload: reloadMetrics } = state;
  useEffect(() => {
    const interval = setInterval(() => {
      reloadJobs();
      reloadMetrics();
    }, 15000);
    return () => clearInterval(interval);
  }, [reloadJobs, reloadMetrics]);
  async function preview() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ approvalId: string }>('/api/send/preview', {
        method: 'POST',
        body: JSON.stringify({ campaignId: id }),
      });
      setApproval(result.approvalId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        All campaigns
      </Button>
      <LoadState {...state} retry={state.reload} />
      {data && (
        <>
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {id} · {data.campaign.channel}
              </p>
              <h1>{data.campaign.campaign_name}</h1>
              <p className="muted">
                {data.campaign.target_country
                  ? `Audience country: ${data.campaign.target_country}`
                  : 'Audience: all eligible countries'}
              </p>
            </div>
            {owner && (
              <div className="action-row">
                <Button variant="outline" onClick={() => setSharing(true)}>
                  <Share2 />
                  Share results
                </Button>
                <Button
                  className="primary"
                  onClick={() => void preview()}
                  disabled={
                    busy || Boolean(job) || jobs.loading || Boolean(jobs.error)
                  }
                >
                  <Send />
                  {busy
                    ? 'Preparing…'
                    : job
                      ? 'Send recorded'
                      : 'Review & send'}
                </Button>
              </div>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Tabs defaultValue="latest">
            <TabsList>
              <TabsTrigger value="latest">Latest send</TabsTrigger>
              <TabsTrigger value="historical">Historical results</TabsTrigger>
            </TabsList>
            <TabsContent value="latest">
              <LoadState {...jobs} retry={jobs.reload} />
              {job ? (
                <>
                  <div className="metrics-grid">
                    {[
                      ['Delivered', data.live_delivered],
                      ['Unique opens', data.live_opened],
                      ['Bounced', data.live_bounced],
                      ['Unsubscribed', data.live_unsubscribed],
                    ].map(([label, value]) => (
                      <div className="metric" key={label}>
                        <p>{label}</p>
                        <strong>{number(Number(value))}</strong>
                      </div>
                    ))}
                  </div>
                  <JobProgress job={job} />
                  <p className="method-note">
                    Counts deduplicate each recipient within each batch. Opens
                    and delivery are independent observations; late events never
                    reverse an unsubscribe.
                  </p>
                </>
              ) : (
                jobs.data && (
                  <NoData
                    title="No send from this portal yet"
                    description={
                      owner
                        ? 'Choose Review & send to see the exact audience before confirming.'
                        : 'Your brand owner can review and send this campaign.'
                    }
                  />
                )
              )}
            </TabsContent>
            <TabsContent value="historical">
              <div className="metrics-grid">
                {[
                  ['Reported sent', data.campaign.reported_sent],
                  ['Reported delivered', data.campaign.reported_delivered],
                  ['Unique opens', data.unique_opens],
                  ['Unique clicks', data.unique_clicks],
                ].map(([label, value]) => (
                  <div className="metric" key={label as string}>
                    <p>{label}</p>
                    <strong>{number(value as number | null)}</strong>
                  </div>
                ))}
              </div>
              <section className="surface definition-panel">
                <h2>How these results are counted</h2>
                <p>
                  Reported sent and delivered are preserved from the campaign
                  export. Unique opens and clicks count distinct customers in
                  the deduplicated raw event log for this campaign.
                </p>
                <p>
                  Deduplicated send-log recipients:{' '}
                  <strong>{number(data.historical_sent)}</strong>. Raw
                  engagement events: <strong>{number(data.event_count)}</strong>
                  .
                </p>
                <p>
                  These sources can disagree. The historical event log does not
                  prove that every sent or delivered message is represented. An
                  unknown denominator is shown as unavailable.
                </p>
              </section>
            </TabsContent>
          </Tabs>
        </>
      )}
      {approval && (
        <ApprovalDialog
          id={approval}
          onClose={() => setApproval(null)}
          onSent={() => {
            setApproval(null);
            jobs.reload();
            state.reload();
          }}
        />
      )}
      {sharing && data && (
        <ShareDialog
          campaign={data.campaign}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}
