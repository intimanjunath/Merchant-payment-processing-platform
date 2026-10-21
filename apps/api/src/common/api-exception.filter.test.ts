import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { Logger } from '@payments/observability';

import { ApiExceptionFilter } from './api-exception.filter';

function fakeHost(headersSent = false) {
  const response = {
    locals: { requestId: 'req-filter-1' },
    headersSent,
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

function fakeLogger() {
  return { error: jest.fn() } as unknown as Logger & { error: jest.Mock };
}

describe('ApiExceptionFilter', () => {
  it('logs unexpected errors with the request ID and returns a 500 envelope', () => {
    const logger = fakeLogger();
    const { host, response } = fakeHost();
    const failure = new Error('database exploded');

    new ApiExceptionFilter(logger).catch(failure, host);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http.request.failed',
        requestId: 'req-filter-1',
        err: failure,
      }),
      expect.any(String),
    );
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'INTERNAL_ERROR', requestId: 'req-filter-1' }),
    });
  });

  it('does not log errors the API meant to return', () => {
    const logger = fakeLogger();
    const { host, response } = fakeHost();

    new ApiExceptionFilter(logger).catch(new NotFoundException(), host);

    expect(logger.error).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
  });

  it('leaves the response alone if headers were already sent', () => {
    const logger = fakeLogger();
    const { host, response } = fakeHost(true);

    new ApiExceptionFilter(logger).catch(new Error('late failure'), host);

    expect(logger.error).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });
});
