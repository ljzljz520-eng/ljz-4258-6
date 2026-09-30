import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T = any> { rows: T[]; rowCount?: number | null }
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

export class PgDb implements Db {
  constructor(private pool: Pool) {}
  async query<T>(sql: string, params: unknown[] = []) {
    return this.pool.query(sql, params) as unknown as Promise<QueryResult<T>>;
  }
  async close() { await this.pool.end(); }
}

export class PGliteDb implements Db {
  constructor(public pglite: PGlite) {}
  async query<T>(sql: string, params: unknown[] = []) {
    return this.pglite.query<T>(sql, params as any) as Promise<QueryResult<T>>;
  }
  async close() { await this.pglite.close(); }
}

export async function connectDb(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    await pool.query('select 1');
    return new PgDb(pool);
  }
  const dataDir = process.env.PGLITE_PATH || join(process.cwd(), '.data', 'pglite');
  await mkdir(dataDir, { recursive: true });
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
  return new PGliteDb(pglite);
}

export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  await pglite.waitReady;
  return new PGliteDb(pglite);
}

export async function migrate(db: Db) {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', 'db', 'migrations', '001_init.sql');
  const sql = await readFile(file, 'utf8');
  for (const statement of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.trim())
    .filter(Boolean)) {
    await db.query(statement);
  }
  await db.query(`
    INSERT INTO schema_migrations(version) VALUES ('001_init')
    ON CONFLICT (version) DO NOTHING
  `);
}
