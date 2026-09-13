import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseExport } from '../lib/import/parser';
import { adminDatabase, requireResult } from '../lib/server/supabase';
const directory = process.argv[2] ?? 'data';
const dryRun = process.argv.includes('--dry-run');
const db = dryRun ? null : adminDatabase();
const files = (await readdir(directory))
  .filter((n) => n.endsWith('.csv'))
  .sort((a, b) => {
    const rank = (n: string) =>
      n.includes('contacts-delta')
        ? 1
        : n.includes('contacts')
          ? 0
          : n.includes('campaigns')
            ? 2
            : n.includes('send-log')
              ? 3
              : 4;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
const report = [];
for (const file of files) {
  const parsed = parseExport(
    basename(file),
    await readFile(join(directory, file)),
  );
  console.log(
    `${file}: ${parsed.rows.length} normalized rows, ${parsed.issues.length} issues`,
  );
  if (!db) {
    report.push({
      file,
      total: parsed.total,
      normalized: parsed.rows.length,
      issues: parsed.issues,
    });
    continue;
  }
  const existing = await db
    .from('import_runs')
    .select('id,status')
    .eq('tenant_id', parsed.tenant)
    .eq('checksum', parsed.checksum)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.status === 'completed') {
    console.log('Already imported; skipped');
    continue;
  }
  const run = requireResult(
    await db
      .from('import_runs')
      .upsert(
        {
          tenant_id: parsed.tenant,
          file_name: file,
          checksum: parsed.checksum,
          source_version: parsed.version,
          status: 'running',
          total_rows: parsed.total,
        },
        { onConflict: 'tenant_id,checksum' },
      )
      .select()
      .single<{ id: string }>(),
  );
  let loaded = 0;
  try {
    // Resume a failed import without duplicating its diagnostics.
    const cleared = await db
      .from('import_issues')
      .delete()
      .eq('import_id', run.id);
    if (cleared.error) throw cleared.error;
    for (let i = 0; i < parsed.rows.length; i += 500) {
      const rows = parsed.rows.slice(i, i + 500);
      const result = await db.rpc('import_row_batch', {
        p_table: parsed.table,
        p_rows: rows,
        p_import: run.id,
      });
      if (result.error) throw result.error;
      loaded += result.data.loaded;
    }
    for (let i = 0; i < parsed.issues.length; i += 500) {
      const result = await db.from('import_issues').insert(
        parsed.issues.slice(i, i + 500).map((x) => ({
          ...x,
          tenant_id: parsed.tenant,
          import_id: run.id,
        })),
      );
      if (result.error) throw result.error;
    }
    const updated = await db.rpc('finish_import', {
      p_import: run.id,
      p_loaded: loaded,
    });
    if (updated.error) throw updated.error;
  } catch (error) {
    await db
      .from('import_runs')
      .update({
        status: 'failed',
        loaded_rows: loaded,
        error_message: (error as Error).message,
      })
      .eq('id', run.id);
    throw error;
  }
}
if (dryRun) {
  await mkdir('work', { recursive: true });
  await writeFile('work/import-report.json', JSON.stringify(report, null, 2));
  console.log('Dry-run report saved in work/import-report.json');
}
