import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

import { MIGRATIONS_DIR } from './paths';

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

// Arbitrary but fixed: every process that migrates takes the same advisory lock,
// so an API and a worker starting together cannot apply the same file twice.
const MIGRATION_LOCK_ID = 727_001;

export interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  for (const name of entries) {
    const match = MIGRATION_FILE.exec(name);
    if (!match?.[1]) {
      throw new Error(`Migration file name must look like 001_description.sql: ${name}`);
    }
    const sql = await readFile(path.join(dir, name), 'utf8');
    migrations.push({ version: match[1], name, checksum: sha256(sql), sql });
  }
  const versions = migrations.map((m) => m.version);
  const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
  if (duplicate) {
    throw new Error(`Two migration files share version ${duplicate}`);
  }
  return migrations;
}

/** Applies pending migrations in order, each in its own transaction. Returns the names applied. */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await ensureMigrationsTable(client);
      const pending = planPending(migrations, await readApplied(client));
      for (const migration of pending) {
        await applyOne(client, migration);
      }
      return pending.map((m) => m.name);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/** Read-only check used by readiness probes. Does not create the tracking table. */
export async function migrationStatus(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const migrations = await loadMigrations(dir);
  const exists = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  const applied = exists.rows[0]?.exists ? await readApplied(pool) : [];
  const pending = planPending(migrations, applied);
  return { applied: applied.map((m) => m.name), pending: pending.map((m) => m.name) };
}

function planPending(files: MigrationFile[], applied: AppliedMigration[]): MigrationFile[] {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const done of applied) {
    const file = byVersion.get(done.version);
    if (!file) {
      throw new Error(`Database has migration ${done.name}, but the file is missing`);
    }
    if (file.checksum !== done.checksum) {
      throw new Error(
        `Migration ${done.name} was changed after it was applied. Add a new migration instead.`,
      );
    }
  }
  const appliedVersions = new Set(applied.map((m) => m.version));
  return files.filter((f) => !appliedVersions.has(f.version));
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function readApplied(db: Pool | PoolClient): Promise<AppliedMigration[]> {
  const result = await db.query<AppliedMigration>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  return result.rows;
}

async function applyOne(client: PoolClient, migration: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Migration ${migration.name} failed`, { cause: error });
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
