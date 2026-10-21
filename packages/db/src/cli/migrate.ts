import { migrate } from '../migrate';
import { createPool, requireDatabaseUrl } from '../pool';

async function main(): Promise<void> {
  const pool = createPool(requireDatabaseUrl(), { applicationName: 'migrate', max: 1 });
  try {
    const applied = await migrate(pool);
    if (applied.length === 0) {
      console.log('Database is up to date.');
    } else {
      for (const name of applied) console.log(`Applied ${name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
