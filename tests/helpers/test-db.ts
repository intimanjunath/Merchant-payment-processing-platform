import { requireDatabaseUrl } from '@payments/db';

/** Tests only ever touch the disposable test database, never DATABASE_URL. */
export function testDatabaseUrl(): string {
  return requireDatabaseUrl('TEST_DATABASE_URL');
}
