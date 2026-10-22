import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { returnToFor } from '../lib/return-to';
import { useSession } from '../lib/use-session';
import { SessionUnavailable } from './SessionUnavailable';

/**
 * Pages behind sign-in: wait for the session check, then show the page, send
 * to sign-in (no session), or offer to check again (no answer from the server).
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <CircularProgress aria-label="Checking your session" />
      </Box>
    );
  }
  if (state.status === 'unavailable') {
    return <SessionUnavailable message={state.message} requestId={state.requestId} />;
  }
  if (state.status === 'signed_out') {
    return <Navigate to="/sign-in" replace state={returnToFor(state, location)} />;
  }
  return children;
}
