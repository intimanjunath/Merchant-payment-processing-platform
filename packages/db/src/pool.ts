import { Pool, type PoolConfig } from 'pg';

/** The parts of a pool error that are safe to log: never the connection string or the raw error. */
export interface PoolErrorDetails {
  applicationName: string;
  message: string;
  code?: string;
}

export type PoolErrorReporter = (details: PoolErrorDetails) => void;

export interface PoolOptions {
  /** Shows up in pg_stat_activity, which helps when several services share a database. */
  applicationName: string;
  max?: number;
  /** Called when an idle connection fails. Defaults to one JSON line on stderr. */
  onIdleClientError?: PoolErrorReporter;
}

export function createPool(connectionString: string, options: PoolOptions): Pool {
  const config: PoolConfig = {
    connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  };
  const pool = new Pool(config);
  const report = options.onIdleClientError ?? writePoolErrorToStderr;

  // pg emits 'error' when an idle connection dies (database restart, network drop,
  // pg_terminate_backend). The pool has already discarded that connection and opens
  // a new one on the next query. Without a listener, Node treats the event as
  // unhandled and exits the process.
  pool.on('error', (error) => {
    try {
      report(describePoolError(error, options.applicationName));
    } catch {
      // A broken reporter must not take the process down with it.
    }
  });

  return pool;
}

export function requireDatabaseUrl(variable = 'DATABASE_URL'): string {
  const value = process.env[variable];
  if (!value) {
    throw new Error(`${variable} is not set. Copy .env.example to .env.`);
  }
  return value;
}

function describePoolError(error: Error, applicationName: string): PoolErrorDetails {
  const code = (error as { code?: unknown }).code;
  return {
    applicationName,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}

function writePoolErrorToStderr(details: PoolErrorDetails): void {
  const line = {
    time: new Date().toISOString(),
    level: 'warn',
    event: 'db.pool.idle_client_error',
    ...details,
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
