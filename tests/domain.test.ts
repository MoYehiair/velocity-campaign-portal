import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consent, timestamp, phone, country } from '../lib/import/normalize';
import { parseExport } from '../lib/import/parser';
import {
  normalizeEvent,
  parseDispatch,
  parseEventPage,
} from '../lib/domain/provider';
import { hashPassword, verifyPassword } from '../lib/server/crypto';

void test('eligibility inputs fail closed and dates never infer a locale', () => {
  for (const value of ['', 'false', '0', 'no', 'f'])
    assert.equal(consent(value), false);
  assert.throws(() => consent('maybe'));
  assert.throws(() => timestamp('01/02/2026 00:10'));
  assert.throws(() => timestamp('2026-02-30T00:00:00Z'));
  assert.equal(country('none'), null);
  assert.equal(phone('garbage', 'KE'), null);
});
void test('source file owns tenancy; mismatched rows are quarantined and exact duplicates are removed', () => {
  const header =
    'external_id,full_name,email,phone,country,city,signup_at,status,consent_marketing,deleted_at,suppressed_until,brand_code,notes';
  const row =
    'CT-1,A,a@vg-eval.test,,KE,Nairobi,2026-01-01T00:00:00Z,active,true,,,KILELE,';
  const parsed = parseExport(
    'kilele-contacts.csv',
    Buffer.from([header, row, row, row.replace('KILELE', 'KAROO')].join('\n')),
  );
  assert.equal(parsed.rows.length, 1);
  assert.equal(
    parsed.issues.filter((i) => i.severity === 'duplicate').length,
    1,
  );
  assert.ok(parsed.issues.some((i) => i.reason.includes('Brand code')));
});
void test('provider events cannot select a tenant or an unapproved recipient', () => {
  const recipients = [
    { id: 'kilele:CT-1', external_id: 'CT-1', destination: 'a@vg-eval.test' },
  ];
  const raw = {
    event_id: 'event1',
    recipient_id: 'kilele:CT-1',
    brand_code: 'KAROO',
    type: 'opened',
    occurred_at: '2026-09-01T00:00:00Z',
  };
  assert.equal(normalizeEvent(raw, recipients).external_contact_id, 'CT-1');
  assert.throws(() =>
    normalizeEvent({ ...raw, recipient_id: 'CT-99' }, recipients),
  );
  assert.throws(() => normalizeEvent({ ...raw, type: 'unknown' }, recipients));
});
void test('incomplete acknowledgements and stuck/missing continuation metadata fail visibly', () => {
  const recipients = [
    { id: 'a', external_id: 'CT-1', destination: 'a@vg-eval.test' },
    { id: 'b', external_id: 'CT-2', destination: 'b@vg-eval.test' },
  ];
  assert.throws(
    () =>
      parseDispatch(
        { batch_id: 'b', accepted: ['a'], rejected: [] },
        recipients,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      parseDispatch(
        {
          batch_id: 'b',
          accepted: ['a', 'b'],
          accepted_count: 3,
          rejected: [],
        },
        recipients,
      ),
    /disagrees/,
  );
  assert.throws(
    () =>
      parseEventPage(
        { batch_id: 'b', events: [], next_cursor: null, has_more: true },
        'b',
      ),
    /cursor/,
  );
});
void test('report passwords are salted and verified without storing plaintext', async () => {
  const a = await hashPassword('a long report password'),
    b = await hashPassword('a long report password');
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('a long report password', a));
  assert.equal(await verifyPassword('wrong password', a), false);
});
