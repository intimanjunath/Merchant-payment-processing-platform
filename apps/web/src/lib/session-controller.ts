import { ApiClient } from './api';
import { clearMerchantRecords } from './browser-records';

export interface Merchant {
  id: string;
  email: string;
  name: string;
}

export interface SessionResponse {
  merchant: Merchant;
  expiresAt: string;
  csrfToken: string | null;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out'; reason: 'none' | 'signed_out' | 'expired' }
  | {
      status: 'signed_in';
      merchant: Merchant;
      csrfToken: string;
      expiresAt: Date;
      /** Which session this is; every asynchronous result checks it before ending the session. */
      generation: number;
    };

export interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface SessionControllerOptions {
  fetch: typeof fetch;
  basePath: string;
  storage: Storage;
  timers: Timers;
  now: () => number;
}

// setTimeout's limit is about 24.8 days; sessions are hours, but stay within it.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The dashboard's session, independent of React. Every session it adopts
 * (sign-in, or the check on page load) gets a new generation. Requests, the
 * expiry timer and sign-out each capture the generation they started under,
 * and may end the session only if that generation is still current, so a
 * late 401, an old timer or a slow sign-out can never end a newer session.
 */
export class SessionController {
  readonly api: ApiClient;
  private state: SessionState = { status: 'loading' };
  private generation = 0;
  private expiryTimer: unknown;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SessionControllerOptions) {
    this.api = new ApiClient({
      fetch: options.fetch,
      basePath: options.basePath,
      session: () => ({
        csrfToken: this.state.status === 'signed_in' ? this.state.csrfToken : null,
        generation: this.generation,
      }),
      onUnauthenticated: (generation) => {
        this.endIfCurrent(generation, 'expired');
      },
    });
  }

  readonly getState = (): SessionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** On page load: is there a session already? Ignored if a sign-in finished first. */
  async load(signal?: AbortSignal): Promise<void> {
    const startedUnder = this.generation;
    try {
      const session = await this.api.get<SessionResponse>(
        '/auth/session',
        signal ? { signal } : {},
      );
      if (this.generation === startedUnder) this.adopt(session);
    } catch {
      // No session, or the API is unreachable: show sign-in, unless something else settled it meanwhile.
      if (!signal?.aborted && this.generation === startedUnder && this.state.status === 'loading') {
        this.set({ status: 'signed_out', reason: 'none' });
      }
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    this.adopt(await this.api.post<SessionResponse>('/auth/login', { body: { email, password } }));
  }

  /**
   * Ends the session on the server, then clears the browser records of the
   * merchant who was signed in when sign-out began. The page signs out only if
   * that same session is still the current one.
   */
  async signOut(): Promise<void> {
    if (this.state.status !== 'signed_in') return;
    const { generation, merchant } = this.state;
    await this.api.post('/auth/logout');
    clearMerchantRecords(this.options.storage, merchant.id);
    this.endIfCurrent(generation, 'signed_out');
  }

  /** Stops the expiry timer, for when the page is torn down. */
  dispose(): void {
    this.clearExpiryTimer();
  }

  private adopt(session: SessionResponse): void {
    if (!session.csrfToken) throw new Error('A browser session always carries a CSRF token');
    this.generation += 1;
    const generation = this.generation;
    const expiresAt = new Date(session.expiresAt);
    this.clearExpiryTimer();
    this.expiryTimer = this.options.timers.setTimeout(
      () => {
        this.endIfCurrent(generation, 'expired');
      },
      Math.max(0, Math.min(MAX_TIMER_MS, expiresAt.getTime() - this.options.now())),
    );
    this.set({
      status: 'signed_in',
      merchant: session.merchant,
      csrfToken: session.csrfToken,
      expiresAt,
      generation,
    });
  }

  /** Ends the session only if `generation` is still the current session's. */
  private endIfCurrent(generation: number, reason: 'signed_out' | 'expired'): void {
    if (this.state.status !== 'signed_in' || this.state.generation !== generation) return;
    this.clearExpiryTimer();
    this.set({ status: 'signed_out', reason });
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== undefined) this.options.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private set(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
