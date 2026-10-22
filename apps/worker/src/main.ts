import { hostname } from 'node:os';

import { createPool, DEFAULT_READINESS_TIMEOUT_MS } from '@payments/db';
import { createLogger, createMetricsRegistry, runOutsideContext } from '@payments/observability';
import { createFakeProvider } from '@payments/provider';

import { ConfigError, loadWorkerConfig } from './config';
import { recoveryHandler } from './handlers/recovery';
import { createHealthServer } from './health';
import { Heartbeat } from './heartbeat';
import { Worker } from './worker';

function main(): void {
  let config;
  try {
    config = loadWorkerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      createLogger({ service: 'worker' }).fatal(
        { event: 'config.invalid', problems: error.problems },
        'Invalid configuration; not starting',
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger({ service: 'worker', level: config.logLevel });
  const pool = createPool(config.databaseUrl, {
    applicationName: 'worker',
    // Logged outside any job's context, or the warning would carry that job's IDs.
    onIdleClientError: (details) => {
      runOutsideContext(() => {
        logger.warn(
          { event: 'db.pool.idle_client_error', ...details },
          'Idle database connection lost',
        );
      });
    },
  });
  const metrics = createMetricsRegistry('worker');
  const provider = createFakeProvider(pool, {
    timeoutMs: config.providerTimeoutMs,
    settlementDelayMs: config.settlementDelayMs,
  });
  const heartbeat = new Heartbeat(metrics, config.heartbeatIntervalMs);
  const worker = new Worker({
    pool,
    logger,
    owner: `worker:${hostname()}:${String(process.pid)}`,
    concurrency: config.concurrency,
    // Beat at least once per heartbeat interval even when the poll interval is longer.
    pollIntervalMs: Math.min(config.pollIntervalMs, config.heartbeatIntervalMs),
    leaseSeconds: config.jobs.leaseSeconds,
    heartbeat,
    // The settlement handler (step 14) is registered here too.
    handlers: {
      operation_recovery: recoveryHandler({
        pool,
        logger,
        provider,
        source: 'worker',
        leaseSeconds: config.jobs.leaseSeconds,
        maxRetries: config.jobs.maxRetries,
        retryBaseMs: config.jobs.retryBaseMs,
        reviewDeadlineSeconds: config.jobs.reviewDeadlineSeconds,
        settlementPollMs: config.pollIntervalMs,
      }),
    },
  });

  let shuttingDown = false;
  const server = createHealthServer({
    pool,
    logger,
    metrics,
    heartbeat,
    readinessTimeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
    isShuttingDown: () => shuttingDown,
  });
  server.listen(config.healthPort, '0.0.0.0');
  worker.start();
  logger.info(
    { event: 'worker.listening', port: config.healthPort },
    'Worker health server listening',
  );

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'worker.shutdown', signal }, 'Shutting down: no new claims');
    void worker
      .stop(config.shutdownGraceMs)
      .then(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      )
      .then(() => pool.end())
      .catch((error: unknown) => {
        logger.error(
          { event: 'worker.shutdown_failed', err: error },
          'Shutdown did not finish cleanly',
        );
        process.exitCode = 1;
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  main();
} catch (error) {
  createLogger({ service: 'worker' }).fatal(
    { event: 'worker.crashed', err: error },
    'Worker failed to start',
  );
  process.exitCode = 1;
}
