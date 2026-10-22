import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useSession } from '../lib/use-session';

/** Pages behind sign-in: wait for the session check, then show the page or send to sign-in. */
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
  if (state.status === 'signed_out') {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}
