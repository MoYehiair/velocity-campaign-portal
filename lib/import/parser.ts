import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
import {
  clean,
  hasUnsupportedControl,
  consent,
  country,
  email,
  InvalidRow,
  nonnegative,
  phone,
  timestamp,
} from './normalize';
import type { TenantId } from '../domain/types';

export interface ImportIssue {
  row_number: number;
  severity: 'error' | 'warning' | 'duplicate';
  reason: string;
  external_id: string | null;
}
export type DataRow = Record<string, unknown>;
export interface ParsedImport {
  tenant: TenantId;
  table: string;
  version: string;
  checksum: string;
  rows: DataRow[];
  issues: ImportIssue[];
  total: number;
}
const aliases: Record<string, string> = {
  e_mail: 'email',
  mobile: 'phone',
  pays: 'country',
};
export function parseExport(fileName: string, bytes: Buffer): ParsedImport {
  const match =
    /^(kilele|karoo|marrakech)-(contacts|campaigns|events|send-log)(?:-delta-(\d{4}-\d{2}-\d{2}))?\.csv$/.exec(
      fileName,
    );
  if (!match) throw new Error('File name is not an approved brand export');
  const tenant = match[1] as TenantId,
    kind = match[2],
    version = match[3] ?? '2026-08-31';
  const table = (
    {
      contacts: 'contacts',
      campaigns: 'campaigns',
      events: 'engagement_events',
      'send-log': 'historical_sends',
    } as Record<string, string>
  )[kind];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (tenant !== 'karoo') throw new Error('Unsupported file encoding');
    text = iconv.decode(bytes, 'windows-1252');
  }
  const records: string[][] = parse(text, {
    bom: true,
    delimiter: tenant === 'marrakech' ? ';' : ',',
    relax_column_count: true,
    skip_empty_lines: true,
  });
  const header = records.shift()?.map((s) => {
    const k = s.trim().toLowerCase().replaceAll(' ', '_');
    return aliases[k] ?? k;
  });
  if (!header || new Set(header).size !== header.length)
    throw new Error('Missing or duplicate column headers');
  const required =
    kind === 'contacts'
      ? [
          'external_id',
          'full_name',
          'status',
          'consent_marketing',
          'brand_code',
        ]
      : kind === 'campaigns'
        ? ['external_id', 'campaign_name', 'channel']
        : kind === 'events'
          ? [
              'event_id',
              'external_contact_id',
              'campaign_external_id',
              'event_type',
              'channel',
              'occurred_at_utc',
            ]
          : [
              'batch_key',
              'campaign_external_id',
              'queued_at_utc',
              'recipient_count',
              'status',
            ];
  if (required.some((k) => !header.includes(k)))
    throw new Error('Required columns are missing');
  const rows: DataRow[] = [],
    issues: ImportIssue[] = [];
  const seen = new Map<string, { row: DataRow; line: number }>(),
    conflicts = new Set<string>();
  for (const [index, cells] of records.entries()) {
    const row_number = index + 2;
    let external_id: string | null = null;
    const issue = (severity: ImportIssue['severity'], reason: string) =>
      issues.push({ row_number, severity, reason, external_id });
    try {
      if (cells.some(hasUnsupportedControl))
        throw new InvalidRow('Unsupported control character in row');
      if (cells.length !== header.length)
        throw new InvalidRow(
          `Expected ${header.length} fields, found ${cells.length}`,
        );
      const raw = Object.fromEntries(header.map((key, i) => [key, cells[i]]));
      external_id = clean(raw.external_id ?? raw.event_id ?? raw.batch_key);
      if (!external_id) throw new InvalidRow('Missing record identifier');
      let row: DataRow = { tenant_id: tenant };
      if (kind === 'contacts') {
        if (clean(raw.brand_code) !== tenant.toUpperCase())
          throw new InvalidRow(
            'Brand code does not match the source file; quarantined',
          );
        if (!/^CT-\d+$/.test(external_id))
          throw new InvalidRow('Invalid contact identifier');
        const status = clean(raw.status)
          .toLowerCase()
          .replace(/^unsubscribe$/, 'unsubscribed');
        if (!['active', 'pending', 'unsubscribed', 'bounced'].includes(status))
          throw new InvalidRow('Unrecognized contact status');
        const region = country(raw.country),
          mail = email(raw.email),
          number = phone(raw.phone, region);
        if (clean(raw.country) && !region)
          issue(
            'warning',
            'Unknown country omitted; local phone numbers cannot be inferred',
          );
        if (clean(raw.email) && !mail)
          issue(
            'warning',
            'Invalid email omitted; contact cannot receive email',
          );
        if (clean(raw.phone) && !number)
          issue('warning', 'Invalid phone omitted; contact cannot receive SMS');
        let signup: string | null = null;
        try {
          signup = timestamp(raw.signup_at);
        } catch (e) {
          issue(
            'warning',
            `${(e as Error).message}; excluded from signup chart`,
          );
        }
        row = {
          ...row,
          external_id,
          full_name: clean(raw.full_name) || external_id,
          email: mail,
          phone: number,
          country: region,
          city: clean(raw.city) || null,
          signup_at: signup,
          status,
          consent_marketing: consent(raw.consent_marketing),
          deleted_at: timestamp(raw.deleted_at),
          suppressed_until: timestamp(raw.suppressed_until),
          source_version: version,
          source_file: fileName,
        };
      } else if (kind === 'campaigns') {
        if (
          !/^(KIL|KAR|MAR)-\d+$/.test(external_id) ||
          !external_id.startsWith(
            { kilele: 'KIL-', karoo: 'KAR-', marrakech: 'MAR-' }[tenant],
          )
        )
          throw new InvalidRow(
            'Campaign identifier belongs to another brand or is invalid',
          );
        if (!['email', 'sms'].includes(clean(raw.channel)))
          throw new InvalidRow('Unsupported campaign channel');
        const target = country(raw.target_country);
        if (clean(raw.target_country) && !target)
          throw new InvalidRow('Unknown target country would broaden audience');
        row = {
          ...row,
          external_id,
          campaign_name: clean(raw.campaign_name),
          channel: clean(raw.channel),
          target_country: target,
          parent_campaign_id: clean(raw.parent_campaign_id) || null,
          spend: nonnegative(raw.spend, false),
          sent_at_utc: timestamp(raw.sent_at_utc),
        };
        for (const k of [
          'reported_sent',
          'reported_delivered',
          'reported_bounced',
          'reported_opens',
          'reported_clicks',
        ])
          row[k] = nonnegative(raw[k]);
      } else if (kind === 'events') {
        if (
          ![
            'open',
            'click',
            'bounce',
            'complaint',
            'unsubscribe',
            'delivered',
          ].includes(raw.event_type)
        )
          throw new InvalidRow('Unknown engagement event type');
        if (!['email', 'sms'].includes(raw.channel))
          throw new InvalidRow('Unknown event channel');
        row = {
          ...row,
          event_id: external_id,
          external_contact_id: clean(raw.external_contact_id),
          campaign_external_id: clean(raw.campaign_external_id),
          event_type: raw.event_type,
          channel: raw.channel,
          occurred_at_utc: timestamp(raw.occurred_at_utc, true),
        };
      } else {
        if (raw.status !== 'sent')
          throw new InvalidRow('Unknown historical send status');
        row = {
          ...row,
          batch_key: external_id,
          campaign_external_id: clean(raw.campaign_external_id),
          queued_at_utc: timestamp(raw.queued_at_utc, true),
          recipient_count: nonnegative(raw.recipient_count),
          status: 'sent',
        };
      }
      const prior = seen.get(external_id);
      if (prior) {
        if (JSON.stringify(prior.row) === JSON.stringify(row))
          issue('duplicate', 'Exact duplicate identifier and values');
        else {
          conflicts.add(external_id);
          issue(
            'error',
            'Conflicting duplicate identifier; all versions quarantined',
          );
          issues.push({
            row_number: prior.line,
            severity: 'error',
            reason:
              'Conflicting duplicate identifier; all versions quarantined',
            external_id,
          });
        }
      } else seen.set(external_id, { row, line: row_number });
    } catch (error) {
      issue('error', (error as Error).message);
    }
  }
  for (const [id, value] of seen)
    if (!conflicts.has(id))
      rows.push({ ...value.row, _source_row: value.line });
  return {
    tenant,
    table,
    version,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    rows,
    issues,
    total: records.length,
  };
}
