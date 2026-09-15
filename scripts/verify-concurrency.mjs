import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
// Install embedded-postgres into a temporary directory; never uses production credentials.
const runtime =
  process.env.TEST_PG_RUNTIME ??
  '/tmp/velocity-postgres-test/node_modules/embedded-postgres/dist/index.js';
const { default: EmbeddedPostgres } = await import(pathToFileURL(runtime).href);
const pg = new EmbeddedPostgres({
  databaseDir: '/tmp/velocity-concurrency-' + Date.now(),
  user: 'postgres',
  password: 'isolated-test',
  port: 55439,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});
await pg.initialise();
await pg.start();
const a = pg.getPgClient(),
  b = pg.getPgClient(),
  observer = pg.getPgClient();
try {
  await Promise.all([a.connect(), b.connect(), observer.connect()]);
  await a.query(
    "create schema auth;create table auth.users(id uuid primary key,email text);create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public,auth to anon,authenticated,service_role;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
  );
  await a.query(await readFile('schema.sql', 'utf8'));
  await a.query(
    "insert into auth.users values('00000000-0000-4000-8000-000000000001','test@test.invalid');insert into memberships values('00000000-0000-4000-8000-000000000001','kilele','test@test.invalid','owner');insert into contacts(tenant_id,external_id,full_name,email,status,consent_marketing,source_version,source_file) values('kilele','CT-1','Test','test@test.invalid','active',true,'2026-08-31','test');insert into campaigns(tenant_id,external_id,campaign_name,channel) values('kilele','ONE','One','email'),('kilele','TWO','Two','email');",
  );
  for (const client of [a, b])
    await client.query(
      "select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);set role authenticated",
    );
  const pid = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
  for (const campaign of ['ONE', 'TWO']) {
    const previewA = (
      await a.query('select preview_campaign($1) id', [campaign])
    ).rows[0].id;
    const previewB =
      campaign === 'ONE'
        ? previewA
        : (await b.query('select preview_campaign($1) id', [campaign])).rows[0]
            .id;
    await a.query('begin');
    const first = (await a.query('select confirm_campaign($1) id', [previewA]))
      .rows[0].id;
    const pending = b.query('select confirm_campaign($1) id', [previewB]).then(
      (r) => ({ result: r.rows[0].id }),
      (e) => ({ error: e.message }),
    );
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const s = (
        await observer.query(
          'select wait_event_type from pg_stat_activity where pid=$1',
          [pid],
        )
      ).rows[0];
      if (s.wait_event_type === 'Lock') {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      blocked,
      'Second session must overlap and wait on a real database lock',
    );
    await a.query('commit');
    const second = await pending;
    if (campaign === 'ONE') assert.equal(second.result, first);
    else assert.match(second.error, /already has a send/);
    const count = (
      await observer.query(
        'select count(*)::int n from send_jobs where campaign_external_id=$1',
        [campaign],
      )
    ).rows[0].n;
    assert.equal(count, 1);
    console.log(
      campaign === 'ONE'
        ? 'PASS: same preview, two independent overlapping sessions, one job'
        : 'PASS: different previews, two independent overlapping sessions, one job',
    );
  }
} finally {
  await Promise.allSettled([a.end(), b.end(), observer.end()]);
  await pg.stop();
}
