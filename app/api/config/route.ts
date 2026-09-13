import { configured } from '@/lib/server/env';
import { json } from '@/lib/server/http';
export function GET() {
  return json({
    configured: configured(),
    url: process.env.SUPABASE_URL ?? null,
    anonKey: process.env.SUPABASE_ANON_KEY ?? null,
  });
}
