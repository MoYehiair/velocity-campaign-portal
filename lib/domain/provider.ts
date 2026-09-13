import { z } from 'zod';
export interface Recipient {
  id: string;
  external_id: string;
  destination: string;
}
const eventSchema = z.object({
  event_id: z.string().min(1),
  recipient_id: z.string().min(1),
  type: z.enum(['delivered', 'bounced', 'opened', 'unsubscribed']),
  occurred_at: z.iso.datetime({ offset: true }),
});
const pageSchema = z.object({
  batch_id: z.string(),
  events: z.array(z.unknown()),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export interface NormalizedEvent {
  event_id: string;
  external_contact_id: string;
  event_type: string;
  occurred_at: string;
  raw: unknown;
}
/** A provider's brand label never determines tenancy. Only our persisted recipient mapping does. */
export function normalizeEvent(
  raw: unknown,
  recipients: Recipient[],
): NormalizedEvent {
  const event = eventSchema.parse(raw);
  const recipient = recipients.find((r) => r.id === event.recipient_id);
  if (!recipient)
    throw new Error('Event recipient is outside the approved batch');
  return {
    event_id: event.event_id,
    external_contact_id: recipient.external_id,
    event_type: event.type,
    occurred_at: event.occurred_at,
    raw,
  };
}
export function parseEventPage(raw: unknown, batchId: string) {
  const page = pageSchema.parse(raw);
  if (page.batch_id !== batchId)
    throw new Error('Provider returned a different batch');
  if (page.has_more && !page.next_cursor)
    throw new Error('Provider omitted the continuation cursor');
  return page;
}
export function parseDispatch(raw: unknown, recipients: Recipient[]) {
  const value = z
    .object({
      batch_id: z.string().min(1),
      accepted: z.array(
        z.union([z.string(), z.object({ id: z.string() }).loose()]),
      ),
      rejected: z.array(
        z.union([z.string(), z.object({ id: z.string() }).loose()]),
      ),
      accepted_count: z.number().int().nonnegative().optional(),
      rejected_count: z.number().int().nonnegative().optional(),
    })
    .parse(raw);
  const identifier = (x: string | { id: string }) =>
    typeof x === 'string' ? x : x.id;
  const all = [...value.accepted, ...value.rejected].map(identifier);
  const requested = new Set(recipients.map((r) => r.id));
  if (
    all.length !== requested.size ||
    new Set(all).size !== all.length ||
    all.some((id) => !requested.has(id))
  )
    throw new Error(
      'Provider acknowledgement is incomplete or includes an unexpected recipient',
    );
  if (
    (value.accepted_count !== undefined &&
      value.accepted_count !== value.accepted.length) ||
    (value.rejected_count !== undefined &&
      value.rejected_count !== value.rejected.length)
  )
    throw new Error(
      'Provider acknowledgement count disagrees with its recipient list',
    );
  return {
    batch_id: value.batch_id,
    accepted: value.accepted.map(identifier),
    rejected: value.rejected,
  };
}
