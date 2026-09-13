/** Secrets are resolved at runtime and this module is imported by server code only. */
export function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Server configuration is incomplete: ${name}`);
  return value;
}
export function configured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}
