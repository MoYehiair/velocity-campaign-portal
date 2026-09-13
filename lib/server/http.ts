import { z } from 'zod';
import { userDatabase } from './supabase';
import type { Membership } from '../domain/types';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
export async function body<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  if (Number(request.headers.get('content-length')) > 16384)
    throw new HttpError(413, 'Request too large');
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  if (reader) {
    while (size <= 16384) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new HttpError(413, 'Request too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new HttpError(
      400,
      'Invalid request. Check the fields and try again.',
    );
  }
}
export async function authenticated(request: Request, owner = false) {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer '))
    throw new HttpError(401, 'Sign in to continue');
  const db = userDatabase(header.slice(7));
  const { data, error } = await db.auth.getUser(header.slice(7));
  if (error || !data.user)
    throw new HttpError(401, 'Your session expired. Sign in again.');
  const membershipResult = await db
    .from('memberships')
    .select('*')
    .eq('user_id', data.user.id)
    .maybeSingle<Membership>();
  if (membershipResult.error) throw membershipResult.error;
  if (!membershipResult.data)
    throw new HttpError(403, 'This account has no brand workspace access');
  const membership = membershipResult.data;
  if (owner && membership.role !== 'owner')
    throw new HttpError(403, 'Only owners can perform this action');
  return { db, membership };
}
export async function route(fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    console.error(
      'Request failed',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return json(
      { error: 'The request could not be completed. Please try again.' },
      500,
    );
  }
}
