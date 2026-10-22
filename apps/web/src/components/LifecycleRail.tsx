import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { formatDateTime, type PaymentState } from '../lib/payments';
import { tokens } from '../theme';

interface Stage {
  key: PaymentState;
  state: string;
  meaning: string;
}

type Tone = 'path' | 'goal' | 'stop' | 'back' | 'ahead';

/** One payment's place on the rail: its state now, and when it reached each one. */
export interface RailProgress {
  state: PaymentState;
  reachedAt: Partial<Record<PaymentState, string>>;
}

// The path every payment can take (spec §3.1), in the merchant's words.
const MAIN: Stage[] = [
  { key: 'pending', state: 'Pending', meaning: 'Sent to the card’s bank; waiting for its answer.' },
  { key: 'authorized', state: 'Authorized', meaning: 'Approved. The amount is held on the card.' },
  { key: 'captured', state: 'Captured', meaning: 'You’ve claimed the money; it’s on its way.' },
  { key: 'settled', state: 'Settled', meaning: 'The money has reached your account.' },
];
const FAILED: Stage = {
  key: 'failed',
  state: 'Failed',
  meaning: 'Declined, or the request never reached the bank.',
};
const REFUNDED: Stage = {
  key: 'refunded',
  state: 'Refunded',
  meaning: 'Returned to the customer.',
};

function Marker({ tone, filled }: { tone: Tone; filled: boolean }) {
  const color = {
    path: tokens.ink,
    goal: tokens.note,
    stop: tokens.alert,
    back: tokens.inkMuted,
    ahead: tokens.rule,
  }[tone];
  return (
    <Box
      aria-hidden
      sx={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        bgcolor: filled ? color : tokens.surface,
        position: 'relative',
        zIndex: 1,
      }}
    />
  );
}

interface Look {
  tone: Tone;
  filled: boolean;
  /** Replaces the stage's meaning: when this payment reached it. */
  note?: string;
  current?: boolean;
}

function Node({ stage, look }: { stage: Stage; look: Look }) {
  return (
    <Box
      component="li"
      aria-current={look.current ? 'step' : undefined}
      sx={{
        listStyle: 'none',
        display: 'grid',
        // Narrow: marker beside the text, on the vertical rail. Wide: marker above, on the horizontal one.
        gridTemplateColumns: { xs: '14px minmax(0, 1fr)', md: 'minmax(0, 1fr)' },
        columnGap: 2,
        rowGap: 1,
        alignContent: 'start',
        alignItems: 'start',
      }}
    >
      <Box sx={{ gridRow: { xs: 'span 2', md: 'auto' }, pt: { xs: 0.5, md: 0 } }}>
        <Marker tone={look.tone} filled={look.filled} />
      </Box>
      <Typography component="span" sx={{ fontWeight: 640, fontSize: '1.0625rem' }}>
        {stage.state}
      </Typography>
      <Typography
        component="span"
        variant="body2"
        color="text.secondary"
        sx={{ maxWidth: '24ch', gridColumn: { xs: 2, md: 'auto' } }}
      >
        {look.note ?? stage.meaning}
      </Typography>
    </Box>
  );
}

/**
 * The payment lifecycle as a rail: the main path left to right, with the two
 * ways off it (failing before authorization, refunding after settlement)
 * dropping below the stage they leave from. On narrow screens it runs top to
 * bottom instead.
 *
 * Without `progress` it explains the path (the sign-in page). With it, it
 * shows one payment: stages it reached are filled and dated, the current one
 * is marked as the current step, and the rest stay pale with their meaning.
 */
export function LifecycleRail({
  caption = 'Every payment you take moves along this path.',
  progress,
}: {
  caption?: string;
  progress?: RailProgress;
}) {
  const look = (stage: Stage, explainer: Look): Look => {
    if (!progress) return explainer;
    const at = progress.reachedAt[stage.key];
    const reached = at !== undefined || progress.state === stage.key;
    if (!reached) return { tone: 'ahead', filled: false };
    return {
      tone: explainer.tone,
      filled: true,
      current: progress.state === stage.key,
      ...(at !== undefined && { note: formatDateTime(at) }),
    };
  };
  return (
    <Box component="figure" sx={{ m: 0 }}>
      <Typography component="figcaption" variant="h4" sx={{ mb: 3.5, maxWidth: '30ch' }}>
        {caption}
      </Typography>
      <Box
        component="ol"
        sx={{
          p: 0,
          m: 0,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' },
          gap: { xs: 3, md: 2 },
          position: 'relative',
          // The rail itself: one line through the markers of the main path.
          '&::before': {
            content: '""',
            position: 'absolute',
            // Pale under one payment's progress, so only its filled markers read as reached.
            bgcolor: progress ? tokens.rule : tokens.ink,
            left: { xs: 6, md: 7 },
            top: { xs: 11, md: 6 },
            width: { xs: 2, md: 'calc(75% + 0.75rem)' },
            height: { xs: 'calc(100% - 4rem)', md: 2 },
          },
        }}
      >
        {MAIN.map((stage, index) => (
          <Node
            key={stage.key}
            stage={stage}
            look={look(
              stage,
              index === MAIN.length - 1
                ? { tone: 'goal', filled: true }
                : { tone: 'path', filled: false },
            )}
          />
        ))}
      </Box>
      <Box
        component="ul"
        aria-label="Ways off the path"
        sx={{
          p: 0,
          m: 0,
          mt: { xs: 3, md: 4.5 },
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' },
          gap: { xs: 3, md: 2 },
          '& > li': {
            position: 'relative',
            // A short drop from the stage above, on wide screens.
            '&::before': {
              content: '""',
              display: { xs: 'none', md: 'block' },
              position: 'absolute',
              left: 7,
              top: -36,
              height: 36,
              borderLeft: `2px dashed ${tokens.rule}`,
            },
          },
          '& > li:nth-of-type(2)': { gridColumn: { md: 4 } },
        }}
      >
        <Node stage={FAILED} look={look(FAILED, { tone: 'stop', filled: false })} />
        <Node stage={REFUNDED} look={look(REFUNDED, { tone: 'back', filled: false })} />
      </Box>
    </Box>
  );
}
