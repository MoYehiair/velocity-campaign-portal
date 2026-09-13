import { z } from 'zod';
import { body, json, route, HttpError } from '@/lib/server/http';
import { adminDatabase, requireResult } from '@/lib/server/supabase';
import { digest, token, verifyPassword } from '@/lib/server/crypto';
async function linkFor(rawToken: string) {
  if (!/^[a-f0-9]{64}$/.test(rawToken))
    throw new HttpError(404, 'Report unavailable');
  const db = adminDatabase();
  const result = await db
    .from('share_links')
    .select('*')
    .eq('token_hash', await digest(rawToken))
    .is('revoked_at', null)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new HttpError(404, 'Report unavailable');
  return { db, link: result.data };
}
export function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  return route(async () => {
    const { token: rawToken } = await params;
    const input = await body(
      request,
      z.object({ password: z.string().min(1).max(128) }).strict(),
    );
    const { db, link } = await linkFor(rawToken);
    // The link itself is the bucket: changing a user-controlled header cannot bypass the limit.
    const allowed = requireResult(
      await db.rpc('allow_share_attempt', { p_bucket: `report:${link.id}` }),
    );
    if (!allowed)
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (!(await verifyPassword(input.password, link.password_hash)))
      throw new HttpError(401, 'Incorrect password');
    const session = token();
    requireResult(
      await db
        .from('share_sessions')
        .insert({
          token_hash: await digest(session),
          link_id: link.id,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        })
        .select('link_id')
        .single(),
    );
    const response = json({ unlocked: true });
    response.headers.set(
      'Set-Cookie',
      `report_session=${session}; HttpOnly; SameSite=Strict; Path=/api/reports/${rawToken}; Max-Age=3600${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
    );
    return response;
  });
}
export function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  return route(async () => {
    const { token: rawToken } = await params;
    const { db, link } = await linkFor(rawToken);
    const session = request.headers
      .get('Cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('report_session='))
      ?.slice(15);
    if (!session || !/^[a-f0-9]{64}$/.test(session))
      throw new HttpError(401, 'Enter the report password');
    const result = await db
      .from('share_sessions')
      .select('link_id')
      .eq('token_hash', await digest(session))
      .eq('link_id', link.id)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new HttpError(401, 'Enter the report password');
    return json(
      requireResult(
        await db.rpc('shared_campaign_results', {
          p_tenant: link.tenant_id,
          p_campaign: link.campaign_external_id,
        }),
      ),
    );
  });
}
