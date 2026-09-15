import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, intercept } from './helpers/isolated-api';
import { runWorker } from '../lib/server/worker';
for (const scenario of [
  'timeout-after-acceptance',
  'crash-before-save',
  'throttled',
  'partial',
  'malformed',
  'permanent-rejection',
]) {
  void test(`isolated real worker: ${scenario}`, async () => {
    const db = await database();
    let calls = 0;
    const acceptedKeys = new Set<string>();
    const requests: { key: string | null; body: string }[] = [];
    await db.exec(
      "insert into auth.users values('00000000-0000-4000-8000-000000000001','owner@test.invalid');insert into memberships values('00000000-0000-4000-8000-000000000001','kilele','owner@test.invalid','owner');select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);insert into contacts(tenant_id,external_id,full_name,email,status,consent_marketing,source_version,source_file) values('kilele','CT-1','A','a@test.invalid','active',true,'2026-08-31','test'),('kilele','CT-2','B','b@test.invalid','active',true,'2026-08-31','test');insert into campaigns(tenant_id,external_id,campaign_name,channel) values('kilele','TEST','Simulation','email');select confirm_campaign(preview_campaign('TEST'));",
    );
    const restore = intercept(db, async (url, init) => {
      if (url.pathname.endsWith('/events'))
        return Response.json({
          batch_id: 'provider-1',
          events: [],
          next_cursor: null,
          has_more: false,
        });
      calls++;
      requests.push({
        key: new Headers(init.headers).get('Idempotency-Key'),
        body: typeof init.body === 'string' ? init.body : '',
      });
      if (scenario !== 'throttled' || calls > 1)
        acceptedKeys.add(requests.at(-1)!.key!);
      if (calls === 1 && scenario === 'timeout-after-acceptance')
        throw new DOMException('Accepted then connection lost', 'TimeoutError');
      if (calls === 1 && scenario === 'throttled')
        return Response.json({}, { status: 429 });
      if (scenario === 'permanent-rejection')
        return Response.json({}, { status: 422 });
      if (calls === 1 && scenario === 'malformed')
        return Response.json({
          batch_id: 'provider-1',
          accepted: ['kilele:CT-1'],
          rejected: [],
        });
      return Response.json({
        batch_id: 'provider-1',
        accepted:
          scenario === 'partial'
            ? ['kilele:CT-1']
            : ['kilele:CT-1', 'kilele:CT-2'],
        rejected: scenario === 'partial' ? ['kilele:CT-2'] : [],
      });
    });
    const adapter = globalThis.fetch;
    let crash = scenario === 'crash-before-save';
    if (crash)
      globalThis.fetch = async (input, init) => {
        if (crash && init?.method === 'PATCH')
          throw new Error('Simulated process loss before database save');
        return adapter(input, init);
      };
    try {
      if (crash) {
        await assert.rejects(runWorker(), (error: { message: string }) =>
          error.message.includes('Simulated process loss'),
        );
        crash = false;
      } else await runWorker();
      const first = (
        await db.query<{ status: string }>('select status from send_batches')
      ).rows[0];
      assert.equal(
        first.status,
        scenario === 'partial'
          ? 'partial'
          : scenario === 'permanent-rejection'
            ? 'failed'
            : 'uncertain',
      );
      if (
        [
          'timeout-after-acceptance',
          'crash-before-save',
          'throttled',
          'malformed',
        ].includes(scenario)
      ) {
        await db.exec(
          "update send_jobs set next_attempt_at=now()-interval '1 second',lease_until=now()-interval '1 second'",
        );
        await runWorker();
        assert.equal(calls, 2);
        assert.deepEqual(requests[0], requests[1]);
        assert.equal(
          acceptedKeys.size,
          1,
          'Provider simulation sees one logical submission',
        );
        assert.equal(
          (
            await db.query<{ status: string }>(
              'select status from send_batches',
            )
          ).rows[0].status,
          'accepted',
        );
      } else {
        await runWorker();
        assert.equal(calls, 1);
      }
      assert.equal(
        (await db.query('select * from send_batches')).rows.length,
        1,
      );
    } finally {
      restore();
      await db.close();
    }
  });
}
