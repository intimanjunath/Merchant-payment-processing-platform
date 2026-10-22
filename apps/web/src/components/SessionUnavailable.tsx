import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import { useSession } from '../lib/use-session';
import { tokens } from '../theme';

/**
 * Shown instead of a signed-in page when the session check got no usable
 * answer. It is not a sign-out: the session may well be valid, so the page
 * offers to check again rather than asking for a password.
 */
export function SessionUnavailable({
  message,
  requestId,
}: {
  message: string;
  requestId: string | null;
}) {
  const { checkSession } = useSession();
  return (
    <Box
      component="main"
      sx={{ maxWidth: 560, mx: 'auto', px: { xs: 2, sm: 4 }, py: { xs: 6, sm: 10 } }}
    >
      <Typography sx={{ fontWeight: 640, mb: 4 }}>Merchant payments</Typography>
      <Typography variant="h3" component="h1" sx={{ mb: 1.5 }}>
        Can’t reach the payment server
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 1 }}>
        The dashboard couldn’t check whether you’re signed in. Your session may still be valid.
      </Typography>
      <Typography sx={{ color: tokens.alert, mb: requestId ? 0.5 : 3 }} role="alert">
        {message}
      </Typography>
      {requestId && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Request ID {requestId}
        </Typography>
      )}
      <Button variant="contained" onClick={() => void checkSession()}>
        Check again
      </Button>
    </Box>
  );
}
