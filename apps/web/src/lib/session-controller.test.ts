import { beforeEach, describe, expect, it } from 'vitest';

import { recordKey } from './browser-records';
import { SessionController, type SessionState } from './session-controller';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const ACME = { id: 'merchant-acme', email: 'merchant1@example.test', name: 'Acme Coffee' };
const BICYCLE = {
  id: 'merchant-bicycle',
  email: 'merchant2@example.test',
  name: 'Blue Bicycle Shop',
};

const sessionBody = (merchant: typeof ACME, csrfToken: string) => ({
  merchant,
  csrfToken,
  expiresAt: new Date(NOW + 60_000).toISOString(),
});
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const unauthenticated = () =>
  json(401, {
    error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.', requestId: 'r' },
  });

/** Answers requests in order of arrival, each one released by the test when it chooses. */
class ControlledFetch {
  readonly calls: {
    method: string;
    path: string;
    csrf: string | undefined;
    answer: (response: Response) => void;
  }[] = [];

  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((resolve) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      this.calls.push({
        method: init?.method ?? 'GET',
        path: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        csrf: headers['X-CSRF-Token'],
        answer: resolve,
      });
    });

  /** The most recent pending call to `path`. */
  last(path: string) {
    const call = this.calls.findLast((candidate) => candidate.path === path);
    if (!call) throw new Error(`no call to ${path}`);
    return call;
  }
}

/** Timers the test fires by hand; a cleared timer is remembered, not forgotten. */
class ManualTimers {
  readonly scheduled: { callback: () => void; ms: number; cleared: boolean }[] = [];
  setTimeout = (callback: () => void, ms: number) => {
    this.scheduled.push({ callback, ms, cleared: false });
    return this.scheduled.length - 1;
  };
  clearTimeout = (handle: unknown) => {
    const timer = this.scheduled[handle as number];
    if (timer) timer.cleared = true;
  };
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SessionController', () => {
  let network: ControlledFetch;
  let timers: ManualTimers;
  let storage: Storage;
  let controller: SessionController;

  beforeEach(() => {
    network = new ControlledFetch();
    timers = new ManualTimers();
    storage = memoryStorage();
    controller = new SessionController({
      fetch: network.fetch,
      basePath: '/api',
      storage,
      timers,
      now: () => NOW,
    });
  });

  const signedIn = (state: SessionState) => (state.status === 'signed_in' ? state : undefined);

  async function signIn(merchant: typeof ACME, csrf: string) {
    const done = controller.signIn(merchant.email, 'password');
    network.last('/api/auth/login').answer(json(200, sessionBody(merchant, csrf)));
    await done;
    return signedIn(controller.getState())?.generation;
  }

  describe('stale results cannot end a newer session', () => {
    it('ignores a 401 from a request that started under an earlier session', async () => {
      await signIn(ACME, 'csrf-1');
      const oldRequest = controller.api.get('/payments').catch(() => undefined);
      const oldCall = network.last('/api/payments');
      const newGeneration = await signIn(ACME, 'csrf-2');

      oldCall.answer(unauthenticated());
      await oldRequest;

      expect(controller.getState()).toMatchObject({
        status: 'signed_in',
        csrfToken: 'csrf-2',
        generation: newGeneration,
      });
    });

    it('ignores a logout that completes after a new session began, but still clears the old merchant’s records', async () => {
      await signIn(ACME, 'csrf-acme');
      storage.setItem(recordKey(ACME.id, 'pending:create'), '{}');
      storage.setItem(recordKey(BICYCLE.id, 'pending:create'), '{}');
      const signingOut = controller.signOut();
      const logout = network.last('/api/auth/logout');
      expect(logout.csrf).toBe('csrf-acme');
      // Meanwhile, Blue Bicycle Shop signs in on this page.
      const newGeneration = await signIn(BICYCLE, 'csrf-bicycle');

      logout.answer(new Response(null, { status: 204 }));
      await signingOut;

      expect(controller.getState()).toMatchObject({
        status: 'signed_in',
        merchant: BICYCLE,
        generation: newGeneration,
      });
      expect(storage.getItem(recordKey(ACME.id, 'pending:create'))).toBeNull();
      expect(storage.getItem(recordKey(BICYCLE.id, 'pending:create'))).toBe('{}');
    });

    it('ignores an expiry timer that fires after a new session began', async () => {
      await signIn(ACME, 'csrf-1');
      const oldTimer = timers.scheduled[0];
      const newGeneration = await signIn(ACME, 'csrf-2');

      expect(oldTimer?.cleared).toBe(true);
      oldTimer?.callback(); // as if it had already been queued when it was cleared

      expect(controller.getState()).toMatchObject({
        status: 'signed_in',
        csrfToken: 'csrf-2',
        generation: newGeneration,
      });
    });

    it('ignores a page-load session check that finishes after a sign-in', async () => {
      const loading = controller.load();
      const check = network.last('/api/auth/session');
      const generation = await signIn(ACME, 'csrf-1');

      check.answer(unauthenticated());
      await loading;

      expect(controller.getState()).toMatchObject({ status: 'signed_in', generation });
    });
    it('ignores a page-load session check that returns an older session after a sign-in', async () => {
      const loading = controller.load();
      const check = network.last('/api/auth/session');
      const generation = await signIn(BICYCLE, 'csrf-bicycle');

      // The cookie the page loaded with still belonged to Acme Coffee's earlier session.
      check.answer(json(200, sessionBody(ACME, 'csrf-acme-old')));
      await loading;

      expect(controller.getState()).toMatchObject({
        status: 'signed_in',
        merchant: BICYCLE,
        csrfToken: 'csrf-bicycle',
        generation,
      });
    });
  });

  describe('the current session still ends normally', () => {
    it('expires when its own timer fires', async () => {
      await signIn(ACME, 'csrf-1');
      const timer = timers.scheduled.at(-1);

      expect(timer?.ms).toBe(60_000);
      timer?.callback();

      expect(controller.getState()).toEqual({ status: 'signed_out', reason: 'expired' });
    });

    it('ends on a 401 from one of its own requests', async () => {
      await signIn(ACME, 'csrf-1');
      const request = controller.api.get('/payments').catch(() => undefined);

      network.last('/api/payments').answer(unauthenticated());
      await request;

      expect(controller.getState()).toEqual({ status: 'signed_out', reason: 'expired' });
      expect(timers.scheduled.at(-1)?.cleared).toBe(true);
    });

    it('signs out, sending its CSRF token and clearing only its own merchant’s records', async () => {
      await signIn(ACME, 'csrf-1');
      storage.setItem(recordKey(ACME.id, 'pending:create'), '{}');
      storage.setItem(recordKey(BICYCLE.id, 'pending:create'), '{}');
      const signingOut = controller.signOut();
      const logout = network.last('/api/auth/logout');

      logout.answer(new Response(null, { status: 204 }));
      await signingOut;

      expect(logout.csrf).toBe('csrf-1');
      expect(controller.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
      expect(storage.getItem(recordKey(ACME.id, 'pending:create'))).toBeNull();
      expect(storage.getItem(recordKey(BICYCLE.id, 'pending:create'))).toBe('{}');
    });

    it('stays signed in, keeping the records, when the logout request fails', async () => {
      await signIn(ACME, 'csrf-1');
      storage.setItem(recordKey(ACME.id, 'pending:create'), '{}');
      const signingOut = controller.signOut();

      network.last('/api/auth/logout').answer(
        json(503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Try later.', requestId: 'r' },
        }),
      );

      await expect(signingOut).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(controller.getState()).toMatchObject({ status: 'signed_in' });
      expect(storage.getItem(recordKey(ACME.id, 'pending:create'))).toBe('{}');
    });

    it('adopts the session found on page load, or shows sign-in when there is none', async () => {
      const withSession = controller.load();
      network.last('/api/auth/session').answer(json(200, sessionBody(ACME, 'csrf-1')));
      await withSession;
      expect(controller.getState()).toMatchObject({
        status: 'signed_in',
        merchant: ACME,
        generation: 1,
      });

      const other = new SessionController({
        fetch: network.fetch,
        basePath: '/api',
        storage,
        timers,
        now: () => NOW,
      });
      const without = other.load();
      network.last('/api/auth/session').answer(unauthenticated());
      await without;
      await flush();
      expect(other.getState()).toEqual({ status: 'signed_out', reason: 'none' });
    });
  });
});
