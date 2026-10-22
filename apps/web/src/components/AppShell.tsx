import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, Outlet } from 'react-router';

import { ApiRequestError } from '../lib/api';
import { useSession } from '../lib/use-session';
import { tokens } from '../theme';

/** The frame around signed-in pages: who is signed in, and the way out. */
export function AppShell() {
  const { state, signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merchant = state.status === 'signed_in' ? state.merchant : null;

  const handleSignOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
    } catch (failure) {
      setError(
        failure instanceof ApiRequestError
          ? `Signing out didn’t finish: ${failure.message}`
          : 'Signing out didn’t finish. Try again.',
      );
      setSigningOut(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <Box
        component="header"
        sx={{
          borderBottom: `1px solid ${tokens.rule}`,
          bgcolor: tokens.surface,
        }}
      >
        <Box
          sx={{
            maxWidth: 1120,
            mx: 'auto',
            px: { xs: 2, sm: 4 },
            py: 1.5,
            display: 'flex',
            alignItems: 'baseline',
            gap: 2,
          }}
        >
          <Typography
            component={RouterLink}
            to="/"
            sx={{ fontWeight: 640, color: 'text.primary', textDecoration: 'none' }}
          >
            Merchant payments
          </Typography>
          {merchant && (
            <Typography color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
              {merchant.name}
            </Typography>
          )}
          <Button onClick={() => void handleSignOut()} disabled={signingOut} color="inherit">
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </Box>
      </Box>
      <Box
        component="main"
        sx={{ maxWidth: 1120, mx: 'auto', px: { xs: 2, sm: 4 }, py: { xs: 3, sm: 5 } }}
      >
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}
        <Outlet />
      </Box>
    </Box>
  );
}
