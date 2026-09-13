import { format } from 'sql-formatter';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const directory = 'supabase/migrations';
for (const file of (await readdir(directory))
  .filter((n) => n.endsWith('.sql'))
  .sort()) {
  const source = await readFile(`${directory}/${file}`, 'utf8');
  // Dollar-quoted function bodies are opaque to the outer SQL tokenizer.
  const bodies: string[] = [];
  const outer = source.replace(/\$\$([\s\S]*?)\$\$/g, (_, body: string) => {
    const index = bodies.push(body) - 1;
    return `$$FUNCTION_BODY_${index}$$`;
  });
  const formatted = format(outer, {
    language: 'postgresql',
    keywordCase: 'lower',
    tabWidth: 2,
  }).replace(/\$\$FUNCTION_BODY_(\d+)\$\$/g, (_, index: string) => {
    const body = format(bodies[Number(index)], {
      language: 'postgresql',
      keywordCase: 'lower',
      tabWidth: 2,
    });
    return `$$\n${body
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}\n$$`;
  });
  await writeFile(`${directory}/${file}`, formatted + '\n');
}
const all = await Promise.all(
  (await readdir(directory))
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFile(`${directory}/${n}`, 'utf8')),
);
await writeFile('schema.sql', all.join('\n'));
