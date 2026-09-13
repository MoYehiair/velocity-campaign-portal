import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const owner = '00000000-0000-4000-8000-000000000001',
  analyst = '00000000-0000-4000-8000-000000000002',
  other = '00000000-0000-4000-8000-000000000003';
async function identity(id: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function root() {
  await db.exec('reset role');
}
async function scalar<T>(sql: string, params: unknown[] = []) {
  return (await db.query<Record<string, T>>(sql, params)).rows[0]?.value;
}
before(async () => {
  await db.exec(
    `create schema auth;create table auth.users(id uuid primary key,email text);create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public,auth to anon,authenticated,service_role;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`,
  );
  await db.exec(await readFile('schema.sql', 'utf8'));
  await db.query('insert into auth.users values($1,$2),($3,$4),($5,$6)', [
    owner,
    'owner@kilele.test',
    analyst,
    'analyst@kilele.test',
    other,
    'owner@karoo.test',
  ]);
  await db.query(
    "insert into memberships values($1,'kilele','owner@kilele.test','owner'),($2,'kilele','analyst@kilele.test','analyst'),($3,'karoo','owner@karoo.test','owner')",
    [owner, analyst, other],
  );
  await db.exec(
    `insert into contacts(tenant_id,external_id,full_name,email,country,status,consent_marketing,source_version,source_file) values('kilele','CT-1','Kilele customer','a@vg-eval.test','KE','active',true,'2026-08-31','kilele-contacts.csv'),('kilele','CT-2','No consent','b@vg-eval.test','KE','active',false,'2026-08-31','kilele-contacts.csv'),('karoo','CT-1','Karoo customer','c@vg-eval.test','ZA','active',true,'2026-08-31','karoo-contacts.csv');insert into campaigns(tenant_id,external_id,campaign_name,channel) values('kilele','KIL-1','Campaign one','email'),('kilele','KIL-2','Campaign two','email'),('kilele','KIL-3','Campaign three','email'),('karoo','KAR-1','Karoo campaign','email');`,
  );
});
after(async () => {
  await db.close();
});

void test('authenticated users see only their own tenant, including through metrics functions', async () => {
  await identity(owner);
  assert.deepEqual((await db.query('select full_name from contacts')).rows, [
    { full_name: 'Kilele customer' },
    { full_name: 'No consent' },
  ]);
  assert.equal(
    await scalar<number>(
      "select count(*)::int as value from contacts where tenant_id='karoo'",
    ),
    0,
  );
  const metrics = await scalar<{ customers: number; contactable: number }>(
    'select dashboard_metrics() as value',
  );
  assert.equal(metrics?.customers, 2);
  assert.equal(metrics?.contactable, 1);
  await identity(other);
  assert.equal(
    await scalar<number>('select count(*)::int as value from contacts'),
    1,
  );
});
void test('isolation regression test demonstrably fails if RLS is disabled', async () => {
  async function assertIsolated() {
    await identity(owner);
    assert.equal(
      await scalar<number>(
        "select count(*)::int as value from contacts where tenant_id='karoo'",
      ),
      0,
    );
  }
  await assertIsolated();
  await root();
  await db.exec('alter table contacts disable row level security');
  try {
    await assert.rejects(assertIsolated, assert.AssertionError);
  } finally {
    await root();
    await db.exec('alter table contacts enable row level security');
  }
  await assertIsolated();
});
void test('analysts cannot send or grant themselves owner access', async () => {
  await identity(analyst);
  await assert.rejects(
    db.query("select preview_campaign('KIL-1')"),
    /Only owners/,
  );
  await assert.rejects(
    db.query("update memberships set role='owner'"),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      "insert into contacts(tenant_id,external_id) values('karoo','CT-999')",
    ),
    /permission denied/,
  );
});
void test('anonymous and unlisted authenticated identities have no route to tenant data', async () => {
  await root();
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from contacts'), /permission denied/);
  await assert.rejects(
    db.query("select shared_campaign_results('kilele','KIL-1')"),
    /permission denied/,
  );
  await identity('00000000-0000-4000-8000-000000000099');
  assert.equal(
    await scalar<number>('select count(*)::int as value from contacts'),
    0,
  );
});
void test('cross-tenant campaigns and forged approvals are rejected', async () => {
  await identity(owner);
  await assert.rejects(
    db.query("select preview_campaign('KAR-1')"),
    /Campaign not found/,
  );
  await assert.rejects(
    db.query("select confirm_campaign('00000000-0000-4000-8000-000000000099')"),
    /Approval not found/,
  );
  await root();
  await assert.rejects(
    db.exec(
      "insert into engagement_events values('kilele','e1','CT-1','KAR-1','open','email',now())",
    ),
    /foreign key/,
  );
});
void test('confirmation is idempotent and two different previews cannot send one campaign twice', async () => {
  await identity(owner);
  const a = await scalar<string>("select preview_campaign('KIL-1') as value"),
    b = await scalar<string>("select preview_campaign('KIL-1') as value");
  const first = await scalar<string>('select confirm_campaign($1) as value', [
    a,
  ]);
  const second = await scalar<string>('select confirm_campaign($1) as value', [
    a,
  ]);
  assert.equal(first, second);
  await assert.rejects(
    db.query('select confirm_campaign($1)', [b]),
    /already has a send/,
  );
  assert.equal(
    await scalar<number>('select count(*)::int as value from send_jobs'),
    1,
  );
  const approval = await scalar<{
    recipient_count: number;
    approved_at: string;
  }>('select to_jsonb(a) as value from send_approvals a where id=$1', [a]);
  assert.equal(approval?.recipient_count, 1);
  assert.ok(approval?.approved_at);
});
void test('changed consent blocks confirmation and does not rewrite the old snapshot', async () => {
  await identity(owner);
  const a = await scalar<string>("select preview_campaign('KIL-2') as value");
  await root();
  await db.exec(
    "update contacts set consent_marketing=false,full_name='Updated name' where tenant_id='kilele' and external_id='CT-1'",
  );
  await identity(owner);
  await assert.rejects(
    db.query('select confirm_campaign($1)', [a]),
    /Audience changed/,
  );
  assert.equal(
    await scalar<string>(
      'select full_name as value from approval_recipients where approval_id=$1',
      [a],
    ),
    'Kilele customer',
  );
  await root();
  await db.exec(
    "update contacts set consent_marketing=true where tenant_id='kilele' and external_id='CT-1'",
  );
});
void test('worker batches and out-of-order provider events preserve suppression and deduplicate', async () => {
  await root();
  const job = await scalar<{ id: string; lease_token: string }>(
    'select to_jsonb(claim_send_job()) as value',
  );
  assert.ok(job?.id);
  await db.query('select prepare_send_batches($1,$2)', [
    job.id,
    job.lease_token,
  ]);
  const batch = (
    await db.query<{ id: string; recipients: unknown[] }>(
      'select id,recipients from send_batches where job_id=$1',
      [job.id],
    )
  ).rows[0];
  assert.equal(batch.recipients.length, 1);
  const event = {
    event_id: 'unsub-1',
    external_contact_id: 'CT-1',
    event_type: 'unsubscribed',
    occurred_at: '2026-09-01T00:00:00Z',
    raw: {},
  };
  await db.query('select store_provider_page($1,$2,$3)', [
    batch.id,
    JSON.stringify([
      event,
      event,
      {
        ...event,
        event_id: 'deliver-1',
        event_type: 'delivered',
        occurred_at: '2026-08-31T00:00:00Z',
      },
    ]),
    null,
  ]);
  assert.equal(
    await scalar<number>('select count(*)::int as value from provider_events'),
    2,
  );
  await identity(owner);
  assert.equal(
    await scalar<boolean>(
      "select is_contactable(c,'email') as value from contacts c where external_id='CT-1'",
    ),
    false,
  );
  await root();
  await assert.rejects(
    db.query('select store_provider_page($1,$2,$3)', [
      batch.id,
      JSON.stringify([
        { ...event, event_id: 'forged', external_contact_id: 'CT-999' },
      ]),
      'bad-cursor',
    ]),
    /does not belong/,
  );
  assert.equal(
    await scalar<string | null>(
      'select event_cursor as value from send_batches where id=$1',
      [batch.id],
    ),
    null,
  );
});
void test('strangers and analysts cannot read shared secrets or call privileged worker functions', async () => {
  await identity(analyst);
  await assert.rejects(
    db.query('select * from share_links'),
    /permission denied/,
  );
  await assert.rejects(
    db.query('select claim_send_job()'),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select shared_campaign_results('kilele','KIL-1')"),
    /permission denied/,
  );
});

void test('real import RPC preserves negative events, diagnoses orphans, and safely resumes', async () => {
  await root();
  const run = await scalar<string>(
    "insert into import_runs(tenant_id,file_name,checksum,source_version,status) values('kilele','test-events.csv','test-import','2026-08-31','running') returning id as value",
  );
  const event = {
    tenant_id: 'kilele',
    event_id: 'import-unsubscribe',
    external_contact_id: 'CT-2',
    campaign_external_id: 'KIL-3',
    event_type: 'unsubscribe',
    channel: 'email',
    occurred_at_utc: '2026-09-01T00:00:00.000Z',
    _source_row: 2,
  };
  const batch = await scalar<{ loaded: number; rejected: number }>(
    'select import_row_batch($1,$2,$3) as value',
    ['engagement_events', JSON.stringify([event]), run],
  );
  assert.equal(batch?.loaded, 1);
  assert.equal(batch?.rejected, 0);
  const replay = await scalar<{ loaded: number; rejected: number }>(
    'select import_row_batch($1,$2,$3) as value',
    ['engagement_events', JSON.stringify([event]), run],
  );
  assert.equal(replay?.loaded, 1);
  assert.equal(replay?.rejected, 0);
  const orphan = {
    ...event,
    event_id: 'orphan-campaign',
    campaign_external_id: 'KIL-999',
    _source_row: 3,
  };
  const rejected = await scalar<{ loaded: number; rejected: number }>(
    'select import_row_batch($1,$2,$3) as value',
    ['engagement_events', JSON.stringify([orphan]), run],
  );
  assert.equal(rejected?.rejected, 1);
  assert.equal(
    await scalar<number>(
      "select count(*)::int as value from suppressions where tenant_id='kilele' and external_contact_id='CT-2' and reason='unsubscribe'",
    ),
    1,
  );
  await db.query('select finish_import($1,$2)', [run, 1]);
  assert.equal(
    await scalar<number>(
      'select rejected_rows as value from import_runs where id=$1',
      [run],
    ),
    1,
  );
});

void test('consent changes after batch preparation block dispatch, and duplicate destinations are not sent twice', async () => {
  await root();
  await db.exec(
    "insert into contacts(tenant_id,external_id,full_name,email,status,consent_marketing,source_version,source_file) values('karoo','CT-3','Same inbox','c@vg-eval.test','active',true,'2026-08-31','test.csv')",
  );
  await identity(other);
  const approval = await scalar<string>(
    "select preview_campaign('KAR-1') as value",
  );
  assert.equal(
    await scalar<number>(
      'select recipient_count as value from send_approvals where id=$1',
      [approval],
    ),
    1,
  );
  await db.query('select confirm_campaign($1)', [approval]);
  await root();
  await db.exec(
    "update send_jobs set status='accepted' where tenant_id='kilele'",
  );
  const job = await scalar<{ id: string; lease_token: string }>(
    'select to_jsonb(claim_send_job()) as value',
  );
  assert.ok(job);
  await db.query('select prepare_send_batches($1,$2)', [
    job.id,
    job.lease_token,
  ]);
  const batch = await scalar<string>(
    'select id as value from send_batches where job_id=$1',
    [job.id],
  );
  await db.exec(
    "update contacts set consent_marketing=false where tenant_id='karoo'",
  );
  assert.equal(
    await scalar<boolean>('select authorize_batch_attempt($1,$2) as value', [
      batch,
      job.lease_token,
    ]),
    false,
  );
  assert.equal(
    await scalar<string>(
      'select status as value from send_batches where id=$1',
      [batch],
    ),
    'failed',
  );
});

void test('a crashed worker recovers the same batch and refreshes real progress without SQL errors', async () => {
  await root();
  const old = (
    await db.query<{ id: string; lease_token: string }>(
      "select id,lease_token from send_jobs where tenant_id='karoo'",
    )
  ).rows[0];
  await db.query('select refresh_send_job($1,$2)', [old.id, old.lease_token]);
  assert.equal(
    await scalar<string>('select status as value from send_jobs where id=$1', [
      old.id,
    ]),
    'failed',
  );
  await db.exec(
    "insert into campaigns(tenant_id,external_id,campaign_name,channel) values('karoo','KAR-2','Recovery test','email');insert into contacts(tenant_id,external_id,full_name,email,status,consent_marketing,source_version,source_file) values('karoo','CT-4','Recovery customer','recovery@vg-eval.test','active',true,'2026-08-31','test.csv')",
  );
  await identity(other);
  const approval = await scalar<string>(
    "select preview_campaign('KAR-2') as value",
  );
  await db.query('select confirm_campaign($1)', [approval]);
  await root();
  const first = await scalar<{ id: string; lease_token: string }>(
    'select to_jsonb(claim_send_job()) as value',
  );
  assert.ok(first);
  await db.query('select prepare_send_batches($1,$2)', [
    first.id,
    first.lease_token,
  ]);
  const batch = (
    await db.query<{
      id: string;
      idempotency_key: string;
      recipients: unknown[];
    }>(
      'select id,idempotency_key,recipients from send_batches where job_id=$1',
      [first.id],
    )
  ).rows[0];
  assert.ok(
    await scalar<boolean>('select authorize_batch_attempt($1,$2) as value', [
      batch.id,
      first.lease_token,
    ]),
  );
  await db.query(
    "update send_jobs set lease_until=now()-interval '1 second' where id=$1",
    [first.id],
  );
  const recovered = await scalar<{ id: string; lease_token: string }>(
    'select to_jsonb(claim_send_job()) as value',
  );
  assert.ok(recovered);
  assert.equal(recovered.id, first.id);
  assert.notEqual(recovered.lease_token, first.lease_token);
  assert.equal(
    await scalar<string>(
      'select idempotency_key as value from send_batches where id=$1',
      [batch.id],
    ),
    batch.idempotency_key,
  );
  assert.ok(
    await scalar<boolean>('select authorize_batch_attempt($1,$2) as value', [
      batch.id,
      recovered.lease_token,
    ]),
  );
  await db.query(
    "update send_batches set status='accepted',accepted='[\"karoo:CT-4\"]',rejected='[]',provider_batch_id='recovery-batch' where id=$1",
    [batch.id],
  );
  await db.query('select refresh_send_job($1,$2)', [
    first.id,
    recovered.lease_token,
  ]);
  assert.equal(
    await scalar<string>('select status as value from send_jobs where id=$1', [
      first.id,
    ]),
    'accepted',
  );
  assert.equal(
    await scalar<number>(
      'select accepted_count as value from send_jobs where id=$1',
      [first.id],
    ),
    1,
  );
});

void test('new tables and functions are inaccessible by default', async () => {
  await root();
  await db.exec(
    "create table public.future_sensitive_table(secret text);insert into public.future_sensitive_table values('private');create function public.future_sensitive_function() returns text language sql as $$select 'private'$$;",
  );
  await identity(owner);
  await assert.rejects(
    db.query('select * from future_sensitive_table'),
    /permission denied/,
  );
  await assert.rejects(
    db.query('select future_sensitive_function()'),
    /permission denied/,
  );
});
