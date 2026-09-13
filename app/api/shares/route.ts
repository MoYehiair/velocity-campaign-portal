import { z } from 'zod';
import { authenticated, body, json, route, HttpError } from '@/lib/server/http';
import { adminDatabase, requireResult } from '@/lib/server/supabase';
import { digest, hashPassword, token } from '@/lib/server/crypto';
import { setting } from '@/lib/server/env';
export function POST(request: Request) {
  return route(async () => {
    const { db, membership } = await authenticated(request, true);
    const input = await body(
      request,
      z
        .object({
          campaignId: z.string().regex(/^(KIL|KAR|MAR)-\d+$/),
          password: z.string().min(12).max(128),
        })
        .strict(),
    );
    const campaign = await db
      .from('campaigns')
      .select('external_id')
      .eq('external_id', input.campaignId)
      .maybeSingle();
    if (campaign.error) throw campaign.error;
    if (!campaign.data) throw new HttpError(404, 'Campaign not found');
    const shareToken = token();
    const admin = adminDatabase();
    const saved = requireResult(
      await admin
        .from('share_links')
        .insert({
          tenant_id: membership.tenant_id,
          campaign_external_id: input.campaignId,
          created_by: membership.user_id,
          token_hash: await digest(shareToken),
          password_hash: await hashPassword(input.password),
        })
        .select('id')
        .single<{ id: string }>(),
    );
    return json(
      { id: saved.id, url: `${setting('APP_URL')}/report/${shareToken}` },
      201,
    );
  });
}
export function DELETE(request: Request) {
  return route(async () => {
    const { membership } = await authenticated(request, true);
    const input = await body(request, z.object({ id: z.uuid() }).strict());
    const result = await adminDatabase()
      .from('share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', input.id)
      .eq('tenant_id', membership.tenant_id);
    if (result.error) throw result.error;
    return json({ revoked: true });
  });
}
