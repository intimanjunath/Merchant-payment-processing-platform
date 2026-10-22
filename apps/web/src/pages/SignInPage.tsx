import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { type SyntheticEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router';

import { LifecycleRail } from '../components/LifecycleRail';
import { ApiRequestError } from '../lib/api';
import { useSession } from '../lib/use-session';
import { tokens } from '../theme';

/** What went wrong, in terms of what the person can do next. */
function describe(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Signing in didn’t finish. Try again.';
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return 'That email and password don’t match an account. Check both and try again.';
    case 'RATE_LIMITED': {
      const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));
      return `Too many sign-in attempts. Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
    }
    case 'VALIDATION_ERROR':
      return 'Enter a valid email address and your password.';
    case 'CSRF_REJECTED':
      return 'Sign-in is only accepted from the dashboard’s own address. Open it directly and try again.';
    default:
      return error.message;
  }
}

export function SignInPage() {
  const { state, signIn } = useSession();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (state.status === 'signed_in') return <Navigate to={from} replace />;

  // Once an attempt fails, its error is the only thing worth reading.
  const notice = error
    ? null
    : state.status === 'signed_out' && state.reason === 'expired'
      ? 'Your session ended. Sign in again to pick up where you left off.'
      : state.status === 'signed_out' && state.reason === 'signed_out'
        ? 'You’re signed out.'
        : null;

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (failure) {
      setError(describe(failure));
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        maxWidth: 1120,
        mx: 'auto',
        px: { xs: 2, sm: 4 },
        py: { xs: 3, md: 6 },
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 5fr) minmax(0, 7fr)' },
        gridTemplateRows: 'auto 1fr',
        columnGap: { md: 8 },
        rowGap: { xs: 4, md: 8 },
      }}
    >
      <Typography sx={{ fontWeight: 640, gridColumn: '1 / -1' }}>Merchant payments</Typography>

      <Box component="main" sx={{ maxWidth: 380 }}>
        <Typography variant="h2" component="h1" sx={{ mb: 1.5 }}>
          Sign in to your merchant account
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          See where every payment stands, and capture or refund when it’s time.
        </Typography>
        {notice && (
          <Alert severity="info" sx={{ mb: 3 }}>
            {notice}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }} role="alert">
            {error}
          </Alert>
        )}
        <Box
          component="form"
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
          sx={{ display: 'grid', gap: 2.5 }}
        >
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            required
            autoFocus
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            required
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={submitting}
            sx={{ justifySelf: 'start', px: 4 }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          bgcolor: tokens.surface,
          border: `1px solid ${tokens.rule}`,
          borderRadius: 1,
          p: { xs: 3, md: 5 },
          alignSelf: 'start',
        }}
      >
        <LifecycleRail />
      </Box>
    </Box>
  );
}
