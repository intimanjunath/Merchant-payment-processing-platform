import { Inject, Injectable } from '@nestjs/common';
import { checkReadiness, type Readiness } from '@payments/db';
import type { Logger } from '@payments/observability';
import type { Pool } from 'pg';

import { DB_POOL, LOGGER, READINESS_TIMEOUT_MS } from '../tokens';

export { DEFAULT_READINESS_TIMEOUT_MS } from '@payments/db';

/** The API's readiness probe; the bounded check itself lives in packages/db. */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  check(): Promise<Readiness> {
    return checkReadiness(this.pool, { logger: this.logger, timeoutMs: this.timeoutMs });
  }
}
