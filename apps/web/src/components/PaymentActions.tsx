import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import type { ActionsState } from '../lib/payment-actions-controller';
import { formatAmount, type PaymentDetails } from '../lib/payments';

type Kind = 'capture' | 'refund';

const COPY: Record<Kind, { button: string; title: string; body: string }> = {
  capture: {
    button: 'Capture',
    title: 'Capture this payment?',
    body: 'This claims the held amount from the customer’s card. It can’t be undone; once the money settles you can refund it.',
  },
  refund: {
    button: 'Refund',
    title: 'Refund this payment?',
    body: 'This returns the full amount to the customer. It can’t be undone.',
  },
};

/** Which action the payment allows now (design §3): capture from Authorized, refund from Settled. */
export function availableAction(details: PaymentDetails): Kind | null {
  if (details.payment.state === 'authorized') return 'capture';
  if (details.payment.state === 'settled') return 'refund';
  return null;
}

/**
 * The payment's one available action, behind a confirmation. It is offered
 * only when nothing else is in flight: no unresolved operation on the server,
 * and no action of ours still waiting for its outcome.
 */
export function PaymentActions({
  details,
  actions,
  onStart,
  onRetry,
}: {
  details: PaymentDetails;
  actions: ActionsState;
  onStart: (kind: Kind) => void;
  onRetry: () => void;
}) {
  const [confirming, setConfirming] = useState<Kind | null>(null);
  const kind = availableAction(details);
  const blocked = details.pendingOperation !== null || actions.pending !== null || actions.busy;
  const amount = formatAmount(details.payment.amount, details.payment.currency);

  return (
    <>
      {actions.message && (
        <Alert
          severity={actions.message.severity}
          action={
            actions.retryable ? (
              <Button
                color="inherit"
                size="small"
                onClick={onRetry}
                disabled={actions.busy}
                sx={{ whiteSpace: 'nowrap' }}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          {actions.message.text}
        </Alert>
      )}
      {kind && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            disabled={blocked}
            onClick={() => {
              setConfirming(kind);
            }}
          >
            {actions.busy ? 'Sending…' : `${COPY[kind].button} ${amount}`}
          </Button>
          {blocked && !actions.busy && (
            <Typography variant="body2" color="text.secondary">
              Available once the current request is confirmed.
            </Typography>
          )}
        </Box>
      )}

      <Dialog
        open={confirming !== null}
        onClose={() => {
          setConfirming(null);
        }}
        aria-labelledby="confirm-action-title"
      >
        {confirming && (
          <>
            <DialogTitle id="confirm-action-title">{COPY[confirming].title}</DialogTitle>
            <DialogContent>
              <DialogContentText>
                {amount} for {details.payment.reference}. {COPY[confirming].body}
              </DialogContentText>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2.5 }}>
              <Button
                color="inherit"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={() => {
                  onStart(confirming);
                  setConfirming(null);
                }}
              >
                {COPY[confirming].button} {amount}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}
