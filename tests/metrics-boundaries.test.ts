import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/isolated-api';
void test('30 local-calendar days include exact lower boundary, exclude tomorrow, unknown and deleted signups', async () => {
  const db = await database();
  try {
    await db.exec(
      "insert into auth.users values('00000000-0000-4000-8000-000000000001','test@test.invalid');insert into memberships values('00000000-0000-4000-8000-000000000001','kilele','test@test.invalid','owner');select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false)",
    );
    for (const timezone of [
      'Africa/Nairobi',
      'Africa/Johannesburg',
      'Africa/Casablanca',
    ]) {
      await db.query("update tenants set timezone=$1 where id='kilele'", [
        timezone,
      ]);
      await db.exec('delete from contacts');
      await db.query(
        `insert into contacts(tenant_id,external_id,full_name,status,source_version,source_file,signup_at,deleted_at)
  select 'kilele','CT-'||i,'Boundary '||i,'active','2026-08-31','test',case i
   when 1 then (((now() at time zone $1)::date-29)::timestamp at time zone $1)
   when 2 then (((now() at time zone $1)::date-29)::timestamp at time zone $1)-interval '1 microsecond'
   when 3 then (((now() at time zone $1)::date+1)::timestamp at time zone $1)-interval '1 microsecond'
   when 4 then (((now() at time zone $1)::date+1)::timestamp at time zone $1)
   when 5 then null else now() end,case when i=6 then now() else null end from generate_series(1,6) i`,
        [timezone],
      );
      await db.exec('set role authenticated');
      const metrics = (
        await db.query<{
          m: {
            customers: number;
            signup_days: { day: string; count: number }[];
          };
        }>('select dashboard_metrics() m')
      ).rows[0].m;
      assert.equal(metrics.customers, 5);
      const page = (
        await db.query<{ p: { total: number; rows: unknown[] } }>(
          "select contact_page(0,'') p",
        )
      ).rows[0].p;
      assert.equal(page.total, 5);
      assert.equal(page.rows.length, 5);
      const emptyPage = (
        await db.query<{ p: { rows: unknown[] } }>(
          "select contact_page(10,'') p",
        )
      ).rows[0].p;
      assert.equal(emptyPage.rows.length, 0);
      assert.equal(metrics.signup_days.length, 30);
      assert.equal(metrics.signup_days[0].count, 1);
      assert.equal(metrics.signup_days[29].count, 1);
      assert.equal(
        metrics.signup_days.reduce((n, d) => n + d.count, 0),
        2,
      );
      await db.exec('reset role');
    }
  } finally {
    await db.close();
  }
});
