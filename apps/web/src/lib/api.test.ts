import { describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiRequestError } from './api';

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function client(answer: Response | Error, csrf: string | null = 'csrf-token') {
  const fetch = vi.fn(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  );
  const onUnauthenticated = vi.fn();
  const api = new ApiClient({
    fetch,
    basePath: '/api',
    session: () => ({ csrfToken: csrf, generation: 7 }),
    onUnauthenticated,
  });
  const sent = () => {
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string> };
  };
  return { api, fetch, onUnauthenticated, sent };
}

describe('ApiClient', () => {
  it('sends reads under the base path, with cookies and without the CSRF token', async () => {
    const { api, sent } = client(respond(200, { ok: true }));

    expect(await api.get('/payments?limit=25')).toEqual({ ok: true });
    expect(sent().url).toBe('/api/payments?limit=25');
    expect(sent().init.credentials).toBe('same-origin');
    expect(sent().headers['X-CSRF-Token']).toBeUndefined();
  });

  it('adds the CSRF token, the idempotency key and a JSON body to mutations', async () => {
    const { api, sent } = client(respond(201, { payment: {} }));

    await api.post('/payments', { body: { amount: 1500 }, idempotencyKey: 'key-1' });

    expect(sent().init.method).toBe('POST');
    expect(sent().headers).toMatchObject({
      'X-CSRF-Token': 'csrf-token',
      'Idempotency-Key': 'key-1',
      'Content-Type': 'application/json',
    });
    expect(sent().init.body).toBe('{"amount":1500}');
  });

  it('sends no CSRF header when there is no session yet (signing in)', async () => {
    const { api, sent } = client(respond(200, {}), null);

    await api.post('/auth/login', { body: { email: 'a@b.test', password: 'x' } });

    expect(sent().headers['X-CSRF-Token']).toBeUndefined();
  });

  it('turns the error envelope into a typed error with its request ID, details and Retry-After', async () => {
    const { api } = client(
      respond(
        429,
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts.',
            requestId: 'req-1',
            details: { fields: [] },
          },
        },
        { 'Retry-After': '120' },
      ),
    );

    const error = await api.post('/auth/login').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Too many attempts.',
      requestId: 'req-1',
      details: { fields: [] },
      retryAfterSeconds: 120,
    });
  });

  it('reports an ended session once, and only for UNAUTHENTICATED', async () => {
    const expired = client(
      respond(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in.', requestId: 'r' } }),
    );
    const wrongPassword = client(
      respond(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'No match.', requestId: 'r' },
      }),
    );

    await expect(expired.api.get('/payments')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(wrongPassword.api.post('/auth/login')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    // With the generation the request started under, so a stale answer can be told apart.
    expect(expired.onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(expired.onUnauthenticated).toHaveBeenCalledWith(7);
    expect(wrongPassword.onUnauthenticated).not.toHaveBeenCalled();
  });

  it('describes an unreachable server as a network error', async () => {
    const { api } = client(new TypeError('Failed to fetch'));

    await expect(api.get('/auth/session')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('describes a non-envelope failure (a proxy page) by its status', async () => {
    const { api } = client(
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'X-Request-Id': 'req-9' },
      }),
    );

    await expect(api.get('/payments')).rejects.toMatchObject({
      status: 502,
      code: 'SERVICE_UNAVAILABLE',
      requestId: 'req-9',
    });
  });

  it('returns nothing for 204 and lets an abort pass through untouched', async () => {
    const empty = client(new Response(null, { status: 204 }));
    const aborted = client(new DOMException('aborted', 'AbortError'));

    expect(await empty.api.post('/auth/logout')).toBeUndefined();
    await expect(aborted.api.get('/auth/session')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
