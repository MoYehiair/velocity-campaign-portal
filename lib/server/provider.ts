import { setting } from './env';
import {
  parseDispatch,
  parseEventPage,
  type Recipient,
} from '../domain/provider';
export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(path: string, init?: RequestInit) {
  const base =
    process.env.MESSAGING_BASE_URL ??
    'https://dispatcher-production-72fc.up.railway.app';
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${setting('MESSAGING_API_KEY')}`);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(12000),
    headers,
  });
  if (!response.ok)
    throw new ProviderError(
      response.status,
      `Messaging provider returned HTTP ${response.status}`,
    );
  return response.json();
}
export async function dispatch(
  key: string,
  brand: string,
  campaign: string,
  channel: string,
  recipients: Recipient[],
) {
  const raw = await request('/v1/messages', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({
      brand,
      campaign,
      recipients: recipients.map((r) => ({
        id: r.id,
        [channel === 'sms' ? 'phone' : 'email']: r.destination,
      })),
    }),
  });
  return parseDispatch(raw, recipients);
}
export async function eventPage(batch: string, cursor: string | null) {
  return parseEventPage(
    await request(
      `/v1/messages/${encodeURIComponent(batch)}/events${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`,
    ),
    batch,
  );
}
