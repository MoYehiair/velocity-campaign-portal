import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
const accounts = JSON.parse(await readFile('secrets/logins.json', 'utf8')) as {
  brand: string;
  role: string;
  email: string;
  password: string;
}[];
const result = [];
for (const account of accounts) {
  const db = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const login = await db.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  assert.ifError(login.error);
  const tables = [
    'contacts',
    'campaigns',
    'engagement_events',
    'suppressions',
    'import_runs',
    'import_issues',
    'historical_sends',
    'send_approvals',
    'approval_recipients',
    'send_jobs',
    'send_batches',
    'provider_events',
    'provider_issues',
    'destination_suppressions',
  ];
  for (const table of tables) {
    const response = await db
      .from(table)
      .select('tenant_id')
      .neq('tenant_id', account.brand)
      .limit(1);
    assert.ifError(response.error);
    assert.deepEqual(response.data, []);
  }
  const started = Date.now();
  const dashboard = await db.rpc('dashboard_metrics');
  assert.ifError(dashboard.error);
  const dashboardMs = Date.now() - started;
  const first = await db.rpc('contact_page', { p_page: 0, p_search: '' });
  assert.ifError(first.error);
  const lastPage = Math.max(0, Math.ceil(first.data.total / 50) - 1);
  const lastStarted = Date.now();
  const last = await db.rpc('contact_page', { p_page: lastPage, p_search: '' });
  assert.ifError(last.error);
  assert.ok(last.data.rows.length > 0 && last.data.rows.length <= 50);
  assert.equal(last.data.total, first.data.total);
  const empty = await db.rpc('contact_page', {
    p_page: 0,
    p_search: 'zz-no-match-qa-98312',
  });
  assert.ifError(empty.error);
  assert.equal(empty.data.total, 0);
  result.push({
    brand: account.brand,
    role: account.role,
    tenantTablesChecked: tables.length,
    dashboardMs,
    lastPageAndEmptySearchMs: Date.now() - lastStarted,
    lastPage,
    total: first.data.total,
    lastPageRows: last.data.rows.length,
  });
  await db.auth.signOut();
}
await writeFile(
  'work/final-live-readonly.json',
  JSON.stringify({ verifiedAt: new Date().toISOString(), result }, null, 2),
);
console.log(JSON.stringify(result));
