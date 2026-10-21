import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger, Registry } from '@payments/observability';
import type { Pool } from 'pg';

import type { ApiConfig } from './config/config';
import { HealthController } from './health/health.controller';
import { DEFAULT_READINESS_TIMEOUT_MS, ReadinessService } from './health/readiness.service';
import { CONFIG, DB_POOL, LOGGER, METRICS, READINESS_TIMEOUT_MS } from './tokens';

export interface ApiDependencies {
  config: ApiConfig;
  logger: Logger;
  pool: Pool;
  metrics: Registry;
  /** Per-phase readiness budget; tests shorten it. Defaults to 2 s. */
  readinessTimeoutMs?: number;
}

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  static register(deps: ApiDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: LOGGER, useValue: deps.logger },
        { provide: DB_POOL, useValue: deps.pool },
        { provide: METRICS, useValue: deps.metrics },
        {
          provide: READINESS_TIMEOUT_MS,
          useValue: deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        },
        ReadinessService,
      ],
    };
  }

  /** The app owns the pool it was given: closing the app closes the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
