import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger, Registry } from '@payments/observability';
import type { PaymentProvider } from '@payments/provider';
import type { Pool } from 'pg';

import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { LoginOriginGuard } from './auth/login-origin.guard';
import { LoginThrottleService } from './auth/login-throttle.service';
import type { ApiConfig } from './config/config';
import { HealthController } from './health/health.controller';
import { DEFAULT_READINESS_TIMEOUT_MS, ReadinessService } from './health/readiness.service';
import { OpenApiController } from './payments/openapi.controller';
import { createPaymentDeps } from './payments/payment-deps';
import { PaymentsController } from './payments/payments.controller';
import { CONFIG, DB_POOL, LOGGER, METRICS, PAYMENT_DEPS, READINESS_TIMEOUT_MS } from './tokens';

export interface ApiDependencies {
  config: ApiConfig;
  logger: Logger;
  pool: Pool;
  metrics: Registry;
  /** Per-phase readiness budget; tests shorten it. Defaults to 2 s. */
  readinessTimeoutMs?: number;
  /** The payment provider; defaults to the durable fake on the same database. */
  provider?: PaymentProvider;
}

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  static register(deps: ApiDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, PaymentsController, OpenApiController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: LOGGER, useValue: deps.logger },
        { provide: DB_POOL, useValue: deps.pool },
        { provide: METRICS, useValue: deps.metrics },
        {
          provide: READINESS_TIMEOUT_MS,
          useValue: deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        },
        { provide: PAYMENT_DEPS, useValue: createPaymentDeps(deps) },
        ReadinessService,
        AuthService,
        AuthGuard,
        LoginOriginGuard,
        LoginThrottleService,
      ],
    };
  }

  /** The app owns the pool it was given: closing the app closes the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
