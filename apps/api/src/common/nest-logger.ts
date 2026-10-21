import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@payments/observability';

/** Sends Nest's own messages (startup, route mapping, crashes) through the JSON logger. */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ event: 'nest', context }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ event: 'nest', context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ event: 'nest', context, stack }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ event: 'nest', context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ event: 'nest', context }, String(message));
  }

  fatal(message: unknown, context?: string): void {
    this.logger.fatal({ event: 'nest', context }, String(message));
  }
}
