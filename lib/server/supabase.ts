import { createClient } from '@supabase/supabase-js';
import { setting } from './env';
export function adminDatabase() {
  return createClient(
    setting('SUPABASE_URL'),
    setting('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
export function userDatabase(token: string) {
  return createClient(setting('SUPABASE_URL'), setting('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export function requireResult<T>(result: {
  data: T | null;
  error: { message: string } | null;
}): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error('Expected record was not found');
  return result.data as NonNullable<T>;
}
