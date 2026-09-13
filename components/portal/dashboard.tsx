'use client';
import {
  Users,
  Mail,
  MessageSquare,
  ArrowUpRight,
  BarChart3,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { useRemote, LoadState, NoData, number } from './common';
import type {
  Dashboard as DashboardData,
  Campaign,
  TenantId,
} from '@/lib/domain/types';
import { brands } from '@/lib/domain/types';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
export function Dashboard({
  tenant,
  onCampaign,
}: {
  tenant: TenantId;
  onCampaign: (id: string) => void;
}) {
  const state = useRemote<DashboardData>('/api/portal?view=dashboard');
  const campaigns = useRemote<Campaign[]>('/api/portal?view=campaigns');
  const data = state.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE OVERVIEW</p>
          <h1>A clearer view of your growth.</h1>
          <p className="muted">
            Your audience and campaign performance, together.
          </p>
        </div>
        <span className="date-chip">
          Last 30 days · {brands[tenant].country}
        </span>
      </div>
      <LoadState {...state} retry={state.reload} />
      {data && (
        <>
          <div className="metrics-grid">
            {[
              {
                label: 'Total customers',
                value: data.customers,
                icon: Users,
                note: 'Excludes deleted customers',
              },
              {
                label: 'Contactable customers',
                value: data.contactable,
                icon: ArrowUpRight,
                note: 'Eligible on at least one channel',
              },
              {
                label: 'Email ready',
                value: data.email_contactable,
                icon: Mail,
                note: 'Consent and valid email required',
              },
              {
                label: 'SMS ready',
                value: data.sms_contactable,
                icon: MessageSquare,
                note: 'Consent and valid phone required',
              },
            ].map(({ label, value, icon: Icon, note }) => (
              <section className="metric" key={label}>
                <div className="metric-label">
                  <p>{label}</p>
                  <Icon size={18} />
                </div>
                <strong>{number(value)}</strong>
                <span>{note}</span>
              </section>
            ))}
          </div>
          <section className="surface chart-surface">
            <div className="section-heading">
              <div>
                <h2>New customers</h2>
                <p>Daily signups over the last 30 calendar days</p>
              </div>
              <span className="chart-legend">
                <i />
                Signups
              </span>
            </div>
            {data.signup_days.length ? (
              <figure
                className="chart"
                aria-label={`Daily customer signups in ${brands[tenant].timezone}`}
              >
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={data.signup_days}
                    margin={{ top: 15, right: 10, left: -15, bottom: 10 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 4"
                      vertical={false}
                      stroke="#e8ebf2"
                    />
                    <XAxis
                      dataKey="day"
                      tickFormatter={(s) =>
                        new Date(`${s}T00:00:00Z`).toLocaleDateString('en', {
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        })
                      }
                      tick={{ fontSize: 12 }}
                      minTickGap={45}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      labelFormatter={(s) => String(s)}
                      cursor={{ fill: '#f1efff' }}
                    />
                    <Bar
                      dataKey="count"
                      name="Signups"
                      fill="#6b59df"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={24}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </figure>
            ) : (
              <NoData
                title="No signup history"
                description="No valid signup dates are available for this period."
              />
            )}
            <p className="chart-caption">
              Source: imported contacts · {brands[tenant].timezone} · Unknown or
              ambiguous signup dates are excluded.
            </p>
          </section>
        </>
      )}
      <section className="surface">
        <div className="section-heading">
          <div>
            <h2>Campaign performance</h2>
            <p>Historical totals from your campaign exports</p>
          </div>
          <BarChart3 size={20} />
        </div>
        <LoadState {...campaigns} retry={campaigns.reload} />
        {campaigns.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Delivery rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.data.map((c) => (
                <TableRow key={c.external_id}>
                  <TableCell>
                    <button
                      className="text-link"
                      onClick={() => onCampaign(c.external_id)}
                    >
                      {c.campaign_name}
                    </button>
                    <small>{c.external_id}</small>
                  </TableCell>
                  <TableCell>
                    <span className="channel">{c.channel}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {number(c.reported_sent)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {number(c.reported_delivered)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.reported_sent && c.reported_delivered !== null
                      ? `${((c.reported_delivered / c.reported_sent) * 100).toFixed(1)}%`
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          campaigns.data && (
            <NoData
              title="No campaigns imported"
              description="Campaigns will appear when your brand’s export is loaded."
            />
          )
        )}
        <p className="method-note">
          Delivery rate = reported delivered ÷ reported sent. Export totals are
          historical claims, not verified delivery receipts. Open a campaign to
          compare its raw engagement log and latest send.
        </p>
      </section>
    </>
  );
}
