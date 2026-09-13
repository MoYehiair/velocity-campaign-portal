import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { adminDatabase, requireResult } from '../lib/server/supabase';
const googleEmail = process.env.DEMO_GOOGLE_EMAIL?.trim().toLowerCase();
if (!googleEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(googleEmail))
  throw new Error(
    'Set DEMO_GOOGLE_EMAIL to a Google email you control before provisioning.',
  );
const db = adminDatabase();
const output: {
  brand: string;
  role: string;
  email: string;
  password: string;
}[] = [];
await mkdir('secrets', { recursive: true });
const file = 'secrets/logins.json';
try {
  output.push(...JSON.parse(await readFile(file, 'utf8')));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
// Auth user listing is explicitly paginated; a pre-existing user may be beyond the first page.
const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  users.push(...data.users);
  if (data.users.length < 100) break;
}
for (const tenant of ['kilele', 'karoo', 'marrakech'])
  for (const role of ['owner', 'analyst']) {
    const email =
      tenant === 'kilele' && role === 'owner'
        ? googleEmail
        : `${tenant}.${role}@vg-eval.test`;
    const existing = await db
      .from('memberships')
      .select('user_id')
      .eq('tenant_id', tenant)
      .eq('role', role)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      console.log(`${tenant} ${role}: already provisioned; password unchanged`);
      continue;
    }
    let user = users.find((u) => u.email?.toLowerCase() === email);
    if (!user) {
      const password = Array.from(randomBytes(24), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      // Persist credentials before creating the account, so a later network failure cannot lose them.
      output.push({ brand: tenant, role, email, password });
      await writeFile(file, JSON.stringify(output, null, 2), { mode: 0o600 });
      const created = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) throw created.error;
      user = created.data.user;
    }
    requireResult(
      await db
        .from('memberships')
        .insert({ user_id: user.id, tenant_id: tenant, role, email })
        .select()
        .single(),
    );
  }
console.log(
  `Provisioning complete. Private credentials: ${file}. Existing accounts were not reset.`,
);
