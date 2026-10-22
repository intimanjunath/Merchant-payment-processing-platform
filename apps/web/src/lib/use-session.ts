import { useContext } from 'react';

import { type Session, SessionContext } from './session';

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
