import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
let client: SupabaseClient | null = null;
export async function browserDatabase() {
  if (client) return client;
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Could not load sign-in configuration');
  const config = z
    .object({
      configured: z.boolean(),
      url: z.string().nullable(),
      anonKey: z.string().nullable(),
    })
    .parse(await response.json());
  if (!config.configured || !config.url || !config.anonKey)
    throw new Error(
      'The workspace is not connected yet. Please contact your administrator.',
    );
  client = createClient(config.url, config.anonKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: false },
  });
  return client;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const db = await browserDatabase();
  const { data, error } = await db.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error('Sign in to continue');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${data.session.access_token}`);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      z.object({ error: z.string() }).parse(result).error ??
        'The request could not be completed',
    );
  return result as T;
}
