import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { parseExport } from '../lib/import/parser';
const db = new PGlite();
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
