import { createPool } from '@payments/db';
import { createLogger, createMetricsRegistry } from '@payments/observability';

import { ConfigError, loadConfig } from '../config/config';
import { createPaymentDeps } from '../payments/payment-deps';
import { seedPayments } from '../seed/payment-seed';

/** Development only: creates the seeded merchants' payments through the payment services. */
async function main(): Promise<void> {
  const config = loadConfig();
  // Warnings and errors only: the provider timeouts here are deliberate.
  const logger = createLogger({ service: 'seed', level: 'warn' });
  const pool = createPool(config.databaseUrl, { applicationName: 'seed-payments', max: 2 });
  try {
    const deps = createPaymentDeps({
      config,
      logger,
      pool,
      metrics: createMetricsRegistry('seed'),
      role: 'seed',
    });
    const seeded = await seedPayments(deps);
    for (const payment of seeded) {
      const waiting = payment.waiting ? ` (waiting for ${payment.waiting})` : '';
      console.log(`${payment.merchant}: ${payment.reference}: ${payment.state}${waiting}`);
    }
    if (seeded.some((payment) => payment.waiting)) {
      console.log('Start the worker, then run this again to finish the waiting payments.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Invalid configuration:\n  ${error.problems.join('\n  ')}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
