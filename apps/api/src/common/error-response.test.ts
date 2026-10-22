import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';

import { ApiError } from './api-error';
import { toErrorResponse } from './error-response';

describe('toErrorResponse', () => {
  it('returns an ApiError as-is, with details and headers', () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'Too many login attempts.', {
      details: { retryAfterSeconds: 60 },
      headers: { 'Retry-After': '60' },
    });

    expect(toErrorResponse(error, 'req-1')).toEqual({
      status: 429,
      body: {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many login attempts.',
          requestId: 'req-1',
          details: { retryAfterSeconds: 60 },
        },
      },
      headers: { 'Retry-After': '60' },
      unexpected: false,
    });
  });

  it('maps an unknown route to NOT_FOUND without echoing the path', () => {
    const response = toErrorResponse(new NotFoundException('Cannot GET /secret/path'), 'req-2');

    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      requestId: 'req-2',
    });
    expect(JSON.stringify(response.body)).not.toContain('/secret/path');
  });

  it('does not pass a framework 400 message through as details', () => {
    const response = toErrorResponse(new BadRequestException(['parser internals here']), 'req-3');

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'The request is not valid.',
      requestId: 'req-3',
    });
  });

  it('maps body-parser failures to VALIDATION_ERROR', () => {
    const malformed = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      status: 400,
      type: 'entity.parse.failed',
    });
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    expect(toErrorResponse(malformed, 'r').body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The request body is not valid JSON.',
    });
    expect(toErrorResponse(tooLarge, 'r')).toMatchObject({
      status: 413,
      body: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(toErrorResponse(new PayloadTooLargeException(), 'r').status).toBe(413);
  });

  it.each([
    ['charset.unsupported', 'unsupported charset "LATIN1"', 'unsupported charset'],
    ['encoding.unsupported', 'unsupported content encoding "x-unknown"', 'Content-Encoding'],
  ])('maps %s to 415 VALIDATION_ERROR', (type, parserMessage, expected) => {
    const error = Object.assign(new Error(parserMessage), { status: 415, type });
    const response = toErrorResponse(error, 'req-415');

    expect(response).toMatchObject({
      status: 415,
      unexpected: false,
      body: { error: { code: 'VALIDATION_ERROR', requestId: 'req-415' } },
    });
    expect(response.body.error.message).toContain(expected);
    // The parser's own text (which echoes request headers) is not passed through.
    expect(response.body.error.message).not.toContain(parserMessage);
  });

  it('keeps body-parser server-side failures as unexpected 500s', () => {
    const error = Object.assign(new Error('stream encoding should not be set'), {
      status: 500,
      type: 'stream.encoding.set',
    });

    expect(toErrorResponse(error, 'r')).toMatchObject({ status: 500, unexpected: true });
  });

  it('hides unexpected errors behind INTERNAL_ERROR and flags them for logging', () => {
    const response = toErrorResponse(new Error('connection string postgres://u:p@db/x'), 'req-4');

    expect(response.status).toBe(500);
    expect(response.unexpected).toBe(true);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
  });

  it('treats a thrown non-error value as unexpected', () => {
    expect(toErrorResponse('just a string', 'req-5')).toMatchObject({
      status: 500,
      unexpected: true,
    });
  });
});
