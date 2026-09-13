import { z } from 'zod';
import { authenticated, body, json, route, HttpError } from '@/lib/server/http';
export function POST(request: Request) {
  return route(async () => {
    const { db } = await authenticated(request, true);
    const input = await body(
      request,
      z.object({ approvalId: z.uuid() }).strict(),
    );
    const { data, error } = await db.rpc('confirm_campaign', {
      p_approval: input.approvalId,
    });
    if (error) throw new HttpError(409, error.message);
    return json({ jobId: data }, 202);
  });
}
