import { createPool, requireDatabaseUrl } from '../pool';
import { seed } from '../seed';

async function main(): Promise<void> {
  const pool = createPool(requireDatabaseUrl(), { applicationName: 'seed', max: 1 });
  try {
    const files = await seed(pool);
    for (const name of files) console.log(`Ran ${name}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
