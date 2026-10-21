import { createPool } from '@payments/db';
import { createLogger, createMetricsRegistry, runOutsideContext } from '@payments/observability';

import { createApp } from './app';
import { ConfigError, loadConfig } from './config/config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      createLogger({ service: 'api' }).fatal(
        { event: 'config.invalid', problems: error.problems },
        'Invalid configuration; not starting',
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger({ service: 'api', level: config.logLevel });
  const pool = createPool(config.databaseUrl, {
    applicationName: 'api',
    // The dropped connection may have been opened during an earlier request;
    // without runOutsideContext the warning would carry that request's ID.
    onIdleClientError: (details) => {
      runOutsideContext(() => {
        logger.warn(
          { event: 'db.pool.idle_client_error', ...details },
          'Idle database connection lost',
        );
      });
    },
  });
  const app = await createApp({ config, logger, pool, metrics: createMetricsRegistry('api') });

  await app.listen(config.port, '0.0.0.0');
  logger.info({ event: 'api.started', port: config.port }, 'API listening');
}

main().catch((error: unknown) => {
  createLogger({ service: 'api' }).fatal(
    { event: 'api.crashed', err: error },
    'API failed to start',
  );
  process.exitCode = 1;
});
