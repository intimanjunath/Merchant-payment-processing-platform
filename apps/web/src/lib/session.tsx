import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import type { ApiClient } from './api';
import { SessionController, type SessionState } from './session-controller';

export type { Merchant, SessionState } from './session-controller';

export interface Session {
  state: SessionState;
  api: ApiClient;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Checks the session again, after the first check could not reach the server. */
  checkSession: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

/**
 * Binds the SessionController to React. On every page load it asks the API for
 * the current session: the token is an HttpOnly cookie the page can't read,
 * so this is how a reload stays signed in and gets a fresh CSRF token.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(
    () =>
      new SessionController({
        fetch: (...args) => window.fetch(...args),
        basePath: '/api',
        storage: window.sessionStorage,
        timers: {
          setTimeout: (callback, ms) => window.setTimeout(callback, ms),
          clearTimeout: (handle) => {
            window.clearTimeout(handle as number);
          },
        },
        now: () => Date.now(),
      }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => {
      abort.abort();
      controller.dispose();
    };
  }, [controller]);

  const signIn = useCallback(
    (email: string, password: string) => controller.signIn(email, password),
    [controller],
  );
  const signOut = useCallback(() => controller.signOut(), [controller]);
  const checkSession = useCallback(() => controller.load(), [controller]);

  const value = useMemo(
    () => ({ state, api: controller.api, signIn, signOut, checkSession }),
    [state, controller, signIn, signOut, checkSession],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
