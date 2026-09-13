import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as portal } from '../app/api/portal/route';
import { POST as preview } from '../app/api/send/preview/route';
import { POST as confirm } from '../app/api/send/confirm/route';
import { POST as share } from '../app/api/shares/route';
import { GET as report } from '../app/api/reports/[token]/route';
import { GET as config } from '../app/api/config/route';
import { body, HttpError } from '../lib/server/http';
import { z } from 'zod';

void test('all private endpoints reject missing authentication before touching a database', async () => {
  for (const [path, handler] of [
    ['portal', portal],
    ['send/preview', preview],
    ['send/confirm', confirm],
    ['shares', share],
  ] as const) {
    const response = await handler(
      new Request(`https://portal.test/api/${path}`, {
        method: path === 'portal' ? 'GET' : 'POST',
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});
void test('public configuration never exposes server secrets', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'private-test-service';
  process.env.MESSAGING_API_KEY = 'private-test-messaging';
  const response = config();
  const data = await response.text();
  assert.ok(data.includes('public-test-key'));
  assert.ok(!data.includes('private-test'));
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.MESSAGING_API_KEY;
});
void test('malformed report addresses cannot reach a report lookup', async () => {
  const response = await report(
    new Request('https://portal.test/api/reports/guessed'),
    { params: Promise.resolve({ token: 'guessed' }) },
  );
  assert.equal(response.status, 404);
});
void test('request parser rejects unexpected fields, invalid JSON, and excessive payloads', async () => {
  const schema = z.object({ id: z.string() }).strict();
  await assert.rejects(
    body(
      new Request('https://portal.test', { method: 'POST', body: 'not-json' }),
      schema,
    ),
    (e) => e instanceof HttpError && e.status === 400,
  );
  await assert.rejects(
    body(
      new Request('https://portal.test', {
        method: 'POST',
        body: JSON.stringify({ id: 'x', tenant: 'other' }),
      }),
      schema,
    ),
  );
  await assert.rejects(
    body(
      new Request('https://portal.test', {
        method: 'POST',
        body: 'x'.repeat(17000),
      }),
      schema,
    ),
    (e) => e instanceof HttpError && e.status === 413,
  );
});
