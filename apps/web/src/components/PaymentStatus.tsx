import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { type Payment, type PaymentState, STATE_LABELS, stateNote } from '../lib/payments';
import { tokens } from '../theme';

type Dot = 'reached' | 'ahead' | 'goal' | 'stop' | 'back';

// The four stops of the main path, as on the sign-in page's lifecycle rail.
const TRACKS: Record<PaymentState, Dot[]> = {
  pending: ['reached', 'ahead', 'ahead', 'ahead'],
  authorized: ['reached', 'reached', 'ahead', 'ahead'],
  captured: ['reached', 'reached', 'reached', 'ahead'],
  settled: ['goal', 'goal', 'goal', 'goal'],
  refunded: ['back', 'back', 'back', 'back'],
  failed: ['stop', 'ahead', 'ahead', 'ahead'],
};

const DOT_COLOR: Record<Dot, string> = {
  reached: tokens.ink,
  ahead: tokens.rule,
  goal: tokens.note,
  stop: tokens.alert,
  back: tokens.inkMuted,
};

/** How far along the main path a payment is; decorative, the label carries the meaning. */
function StatusTrack({ state }: { state: PaymentState }) {
  return (
    <Box aria-hidden sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      {TRACKS[state].map((dot, index) => (
        <Box key={index} sx={{ display: 'flex', alignItems: 'center' }}>
          {index > 0 && (
            <Box
              sx={{
                width: 6,
                height: 2,
                bgcolor: dot === 'ahead' ? tokens.rule : DOT_COLOR[dot],
              }}
            />
          )}
          <Box
            sx={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              border: `2px solid ${DOT_COLOR[dot]}`,
              bgcolor: dot === 'ahead' ? tokens.surface : DOT_COLOR[dot],
            }}
          />
        </Box>
      ))}
    </Box>
  );
}

/** The payment's state, its place on the path, and a note for failures and review. */
export function PaymentStatus({ payment }: { payment: Payment }) {
  const note = stateNote(payment);
  const tone =
    payment.state === 'failed'
      ? tokens.alert
      : payment.state === 'settled'
        ? tokens.note
        : tokens.ink;
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <StatusTrack state={payment.state} />
        <Typography component="span" sx={{ fontWeight: 560, color: tone }}>
          {STATE_LABELS[payment.state]}
        </Typography>
      </Box>
      {note && (
        <Typography
          variant="body2"
          sx={{ color: payment.settlementReview ? tokens.alert : 'text.secondary', mt: 0.25 }}
        >
          {note}
        </Typography>
      )}
    </Box>
  );
}
