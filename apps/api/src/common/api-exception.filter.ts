import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Logger } from '@payments/observability';
import type { Response } from 'express';

import { toErrorResponse } from './error-response';
import { requestIdOf } from './request-tracking';

/** Turns every error into the API's JSON error envelope (spec §4.2). */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = requestIdOf(response);
    const result = toErrorResponse(exception, requestId);

    if (result.unexpected) {
      this.logger.error(
        { event: 'http.request.failed', requestId, err: exception },
        'Unhandled error while handling a request',
      );
    }
    if (response.headersSent) {
      return;
    }
    // Errors carry request IDs and are never worth caching.
    response
      .status(result.status)
      .set({ 'Cache-Control': 'no-store', ...result.headers })
      .json(result.body);
  }
}
