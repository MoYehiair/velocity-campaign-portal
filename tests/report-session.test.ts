import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, intercept } from './helpers/isolated-api';
import { digest, hashPassword } from '../lib/server/crypto';
import { GET, POST } from '../app/api/reports/[token]/route';
void test('real report routes reject expired sessions, rate-limit guesses, and recover after window', async () => {
  const db = await database();
  const restore = intercept(db, async () => {
    throw Error('Provider forbidden');
  });
  try {
    const token = 'a'.repeat(64),
      session = 'b'.repeat(64);
    const url = 'https://portal.invalid/api/reports/' + token;
    await db.exec(
      "insert into auth.users values('00000000-0000-4000-8000-000000000001','test@test.invalid');insert into campaigns(tenant_id,external_id,campaign_name,channel) values('kilele','TEST','Test report','email')",
    );
    const link = (
      await db.query<{ id: string }>(
        "insert into share_links(tenant_id,campaign_external_id,token_hash,password_hash,created_by) values('kilele','TEST',$1,$2,'00000000-0000-4000-8000-000000000001') returning id",
        [await digest(token), await hashPassword('test-password')],
      )
    ).rows[0].id;
    await db.query(
      "insert into share_sessions(token_hash,link_id,expires_at) values($1,$2,now()-interval '1 second')",
      [await digest(session), link],
    );
    const params = { params: Promise.resolve({ token }) };
    const read = () =>
      GET(
        new Request(url, { headers: { Cookie: 'report_session=' + session } }),
        params,
      );
    assert.equal((await read()).status, 401);
    await db.query(
      "update share_sessions set expires_at=now()+interval '1 hour'",
    );
    assert.equal((await read()).status, 200);
    const unlock = (password: string) =>
      POST(
        new Request(url, {
          method: 'POST',
          body: JSON.stringify({ password }),
        }),
        params,
      );
    for (let i = 0; i < 10; i++)
      assert.equal((await unlock('wrong')).status, 401);
    assert.equal((await unlock('test-password')).status, 429);
    await db.exec(
      "update share_attempts set window_start=now()-interval '16 minutes'",
    );
    assert.equal((await unlock('test-password')).status, 200);
    await db.query('update share_links set revoked_at=now() where id=$1', [
      link,
    ]);
    assert.equal((await read()).status, 404);
  } finally {
    restore();
    await db.close();
  }
});
