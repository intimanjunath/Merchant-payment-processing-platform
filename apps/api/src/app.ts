import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHttpMetrics } from '@payments/observability';
import cookieParser from 'cookie-parser';

import { type ApiDependencies, AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { NestLogger } from './common/nest-logger';
import {
  bindRequestContext,
  handleBodyParserErrors,
  trackRequests,
} from './common/request-tracking';

const JSON_BODY_LIMIT = '64kb';

/**
 * Builds the API without listening, so tests can drive it with Supertest.
 * Closing the app also closes the database pool passed in.
 */
export async function createApp(deps: ApiDependencies): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    bodyParser: false,
    logger: new NestLogger(deps.logger),
    abortOnError: false,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);

  // Order matters: track first (request ID, timing), then parse, then bind the log context.
  app.use(trackRequests(deps.logger, createHttpMetrics(deps.metrics)));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(handleBodyParserErrors);
  app.use(bindRequestContext);
  app.use(cookieParser());

  // Unknown fields are rejected, not silently dropped: a field such as cardNumber
  // must fail loudly rather than be accepted and ignored.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  app.useGlobalFilters(new ApiExceptionFilter(deps.logger));
  app.enableShutdownHooks();
  return app;
}
