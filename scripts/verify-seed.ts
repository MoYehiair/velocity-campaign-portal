import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { parseExport } from '../lib/import/parser';
let nativeStop: (() => Promise<void>) | undefined;
let db: PGlite;
if (process.env.TEST_NATIVE_PG === '1') {
  const { pathToFileURL } = await import('node:url');
  const runtime =
    process.env.TEST_PG_RUNTIME ??
    '/tmp/velocity-postgres-test/node_modules/embedded-postgres/dist/index.js';
  const { default: EmbeddedPostgres } = await import(
    pathToFileURL(runtime).href
  );
  const server = new EmbeddedPostgres({
    databaseDir: '/tmp/velocity-seed-' + Date.now(),
    user: 'postgres',
    password: 'isolated-test',
    port: 55440,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  const client = server.getPgClient();
  await client.connect();
  await client.query('set jit=off');
  db = {
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
    exec: (sql: string) => client.query(sql),
    close: async () => {
      await client.end();
      await server.stop();
    },
  } as unknown as PGlite;
  nativeStop = () => db.close();
  process.once('SIGINT', () => {
    void nativeStop?.().finally(() => process.exit(130));
  });
} else db = new PGlite();
await db.exec(
  "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public,auth to anon,authenticated,service_role;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
);
await db.exec(await readFile('schema.sql', 'utf8'));
const files = (await readdir('data'))
  .filter((n) => n.endsWith('.csv'))
  .sort((a, b) => {
    const rank = (s: string) =>
      s.includes('contacts-delta')
        ? 1
        : s.includes('contacts')
          ? 0
          : s.includes('campaigns')
            ? 2
            : s.includes('send-log')
              ? 3
              : 4;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
for (const file of files) {
  const data = parseExport(file, await readFile(`data/${file}`));
  const run = (
    await db.query<{ id: string }>(
      "insert into import_runs(tenant_id,file_name,checksum,source_version,status,total_rows) values($1,$2,$3,$4,'running',$5) returning id",
      [data.tenant, file, data.checksum, data.version, data.total],
    )
  ).rows[0];
  let loaded = 0;
  for (let i = 0; i < data.rows.length; i += 500) {
    const result = (
      await db.query<{ result: { loaded: number } }>(
        'select import_row_batch($1,$2,$3) as result',
        [data.table, JSON.stringify(data.rows.slice(i, i + 500)), run.id],
      )
    ).rows[0].result;
    loaded += result.loaded;
  }
  for (let i = 0; i < data.issues.length; i += 500) {
    await db.query(
      'insert into import_issues(tenant_id,import_id,row_number,severity,reason,external_id) select $1,$2,x.row_number,x.severity,x.reason,x.external_id from jsonb_to_recordset($3) x(row_number int,severity text,reason text,external_id text)',
      [data.tenant, run.id, JSON.stringify(data.issues.slice(i, i + 500))],
    );
  }
  await db.query('select finish_import($1,$2)', [run.id, loaded]);
  console.log(file, loaded, 'loaded');
}
// Replay every raw export through the actual importer, including the old baseline after the delta.
const fingerprint = async () => {
  const output: Record<string, unknown> = {};
  for (const table of [
    'contacts',
    'campaigns',
    'engagement_events',
    'historical_sends',
  ]) {
    output[table] = (
      await db.query(
        `select count(*)::int n, md5(string_agg(row_to_json(t)::text, '' order by row_to_json(t)::text)) checksum from ${table} t`,
      )
    ).rows;
  }
  return output;
};
const beforeReplay = await fingerprint();
for (const file of files) {
  const parsed = parseExport(file, await readFile(`data/${file}`));
  const run = (
    await db.query<{ id: string }>(
      'select id from import_runs where checksum=$1 and tenant_id=$2',
      [parsed.checksum, parsed.tenant],
    )
  ).rows[0];
  await db.query("update import_runs set status='running' where id=$1", [
    run.id,
  ]);
  for (let i = 0; i < parsed.rows.length; i += 500)
    await db.query('select import_row_batch($1,$2,$3)', [
      parsed.table,
      JSON.stringify(parsed.rows.slice(i, i + 500)),
      run.id,
    ]);
  await db.query("update import_runs set status='completed' where id=$1", [
    run.id,
  ]);
}
assert.deepEqual(
  await fingerprint(),
  beforeReplay,
  'Full replay must not change customer, campaign, send-log or event records',
);
console.log(
  'PASS: all exports replayed; complete data fingerprints unchanged, including baseline after delta',
);
const rejectionReasons = (
  await db.query(
    "select reason,count(*) from import_issues where severity='error' group by reason order by count(*) desc limit 20",
  )
).rows;
const summary = (
  await db.query(
    'select file_name,total_rows,loaded_rows,rejected_rows,duplicate_rows,warning_rows from import_runs order by file_name',
  )
).rows;
const tenants = (
  await db.query(
    "select t.id,(select count(*) from contacts c where c.tenant_id=t.id and deleted_at is null) customers,(select count(*) from contacts c where c.tenant_id=t.id and (is_contactable(c,'email') or is_contactable(c,'sms'))) contactable,(select count(*) from engagement_events e where e.tenant_id=t.id) events from tenants t",
  )
).rows;
await mkdir('work', { recursive: true });
await writeFile(
  'work/seed-verification.json',
  JSON.stringify(
    {
      verified_at: new Date().toISOString(),
      fullReplayUnchanged: true,
      imports: summary,
      tenants,
      rejectionReasons,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ imports: summary, tenants, rejectionReasons }));
await db.close();
