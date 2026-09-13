import { z } from 'zod';
import { authenticated, body, json, route, HttpError } from '@/lib/server/http';
export function POST(request: Request) {
  return route(async () => {
    const { db } = await authenticated(request, true);
    const input = await body(
      request,
      z
        .object({ campaignId: z.string().regex(/^(KIL|KAR|MAR)-\d+$/) })
        .strict(),
    );
    const { data, error } = await db.rpc('preview_campaign', {
      p_campaign: input.campaignId,
    });
    if (error) throw new HttpError(409, error.message);
    return json({ approvalId: data });
  });
}
