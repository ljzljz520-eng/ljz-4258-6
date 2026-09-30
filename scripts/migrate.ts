import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://ferment:ferment@localhost:5432/ferment_records';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'db', 'migrations');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const existed = await client.query('select 1 from schema_migrations where name=$1', [file]);
    if (existed.rowCount) continue;
    console.log(`Applying ${file}`);
    await client.query('begin');
    await client.query(await fs.readFile(path.join(dir, file), 'utf8'));
    await client.query('insert into schema_migrations(name) values ($1)', [file]);
    await client.query('commit');
  }
} finally {
  await client.end();
}
