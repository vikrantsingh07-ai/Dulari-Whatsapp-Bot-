import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from './client.js';

export async function migrate() {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  await getPool().query(sql);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then(() => { console.log('schema applied'); return closePool(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
