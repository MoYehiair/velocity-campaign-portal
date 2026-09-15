import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
export async function database() {
  const db = new PGlite();
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key,email text);create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public,auth to anon,authenticated,service_role;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
  );
  await db.exec(await readFile('schema.sql', 'utf8'));
  return db;
}
// Test-only PostgREST adapter. Every network request is intercepted; unknown hosts fail closed.
export function intercept(
  db: PGlite,
  provider: (url: URL, init: RequestInit) => Promise<Response>,
) {
  const previous = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://database.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
  process.env.MESSAGING_BASE_URL = 'https://provider.invalid';
  process.env.MESSAGING_API_KEY = 'test-only';
  const ident = (s: string) => {
    if (!/^[a-z_]+$/.test(s)) throw Error('Invalid test identifier');
    return '"' + s + '"';
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === 'provider.invalid') return provider(url, init);
    if (url.hostname !== 'database.invalid')
      throw Error('External network forbidden: ' + url.hostname);
    try {
      const path = url.pathname.split('/').pop()!;
      const body = init.body
        ? JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        : null;
      if (url.pathname.includes('/rpc/')) {
        const entries = Object.entries(body ?? {});
        const args = entries
          .map(([k], i) => `${ident(k)} => $${i + 1}`)
          .join(',');
        const result = await db.query<{ value: unknown }>(
          `select to_jsonb(public.${ident(path)}(${args})) as value`,
          entries.map(([, v]) =>
            typeof v === 'object' ? JSON.stringify(v) : v,
          ),
        );
        return Response.json(result.rows[0]?.value ?? null);
      }
      const values: unknown[] = [];
      const bind = (v: unknown) => {
        values.push(v);
        return '$' + values.length;
      };
      const clauses: string[] = [];
      for (const [key, raw] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        if (raw === 'is.null') clauses.push(`${ident(key)} is null`);
        else if (raw === 'not.is.null')
          clauses.push(`${ident(key)} is not null`);
        else if (raw.startsWith('in.('))
          clauses.push(
            `${ident(key)} in (${raw.slice(4, -1).split(',').map(bind).join(',')})`,
          );
        else {
          const dot = raw.indexOf('.');
          const op = raw.slice(0, dot);
          clauses.push(
            `${ident(key)} ${{ eq: '=', gt: '>', lt: '<', neq: '!=' }[op] ?? '='} ${bind(raw.slice(dot + 1))}`,
          );
        }
      }
      const where = clauses.length ? ' where ' + clauses.join(' and ') : '';
      let sql = '';
      if (init.method === 'PATCH')
        sql = `update ${ident(path)} set ${Object.entries(body)
          .map(
            ([k, v]) =>
              `${ident(k)}=${bind(typeof v === 'object' ? JSON.stringify(v) : v)}`,
          )
          .join(',')}${where} returning *`;
      else if (init.method === 'POST') {
        const entries = Object.entries(body);
        sql = `insert into ${ident(path)} (${entries.map(([k]) => ident(k)).join(',')}) values (${entries.map(([, v]) => bind(typeof v === 'object' ? JSON.stringify(v) : v)).join(',')}) returning *`;
      } else {
        sql = `select * from ${ident(path)}${where}`;
        const order = url.searchParams.get('order');
        if (order)
          sql +=
            ' order by ' +
            order
              .split(',')
              .map((x) => {
                const [key, dir, nulls] = x.split('.');
                return `${ident(key)} ${dir === 'desc' ? 'desc' : 'asc'} ${nulls === 'nullsfirst' ? 'nulls first' : ''}`;
              })
              .join(',');
        const limit = url.searchParams.get('limit');
        if (limit) sql += ' limit ' + Number(limit);
      }
      const result = await db.query(sql, values);
      const headers = new Headers(init.headers);
      return Response.json(
        headers.get('accept')?.includes('vnd.pgrst.object')
          ? (result.rows[0] ?? null)
          : result.rows,
      );
    } catch (e) {
      return Response.json({ message: (e as Error).message }, { status: 400 });
    }
  };
  return () => {
    globalThis.fetch = previous;
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'MESSAGING_BASE_URL',
      'MESSAGING_API_KEY',
    ])
      delete process.env[key];
  };
}
