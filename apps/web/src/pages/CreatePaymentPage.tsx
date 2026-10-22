import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import Link from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { type SyntheticEvent, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { ApiRequestError } from '../lib/api';
import { refusalText } from '../lib/payment-actions-controller';
import {
  type CreateInput,
  finishCreate,
  NOT_SAVED_TEXT,
  type PendingAction,
  submitCreate,
  type TestToken,
} from '../lib/pending-actions';
import { formatAmount, parseAmount } from '../lib/payments';
import { useIsActive } from '../lib/use-is-active';
import { usePendingStore } from '../lib/use-payment-actions';
import { useSession } from '../lib/use-session';
import { tokens } from '../theme';

// The provider's test cards (spec §6), described by what they do.
const CARDS: { token: TestToken; card: string; outcome: string }[] = [
  { token: 'pm_card_visa', card: 'Visa ending 4242', outcome: 'The bank approves it.' },
  { token: 'pm_card_declined', card: 'Visa ending 0002', outcome: 'The bank declines it.' },
  {
    token: 'pm_timeout',
    card: 'Mastercard ending 4444',
    outcome: 'The request never reaches the bank; the payment fails after a check.',
  },
  {
    token: 'pm_lost_response',
    card: 'Amex ending 0005',
    outcome: 'The bank approves it, but its answer is lost; confirmed a few seconds later.',
  },
];

type CreateRecord = Extract<PendingAction, { kind: 'create' }>;

/**
 * A new test payment. Only one create is pending at a time: while one waits
 * for its outcome, the page offers to finish it (same key) instead of a new
 * form, so a lost answer can never turn into a second charge.
 */
export function CreatePaymentPage() {
  const store = usePendingStore();
  const [, setVersion] = useState(0);
  const pending = store.create();

  return (
    <Box sx={{ maxWidth: 640 }}>
      <Box sx={{ mb: 3 }}>
        <Link component={RouterLink} to="/" underline="hover" sx={{ fontWeight: 560 }}>
          Back to payments
        </Link>
      </Box>
      <Typography variant="h2" component="h1" sx={{ mb: 1 }}>
        New payment
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        Take a test payment. The dashboard accepts only the provider’s test cards, never real card
        numbers.
      </Typography>
      {pending ? (
        <PendingCreate
          pending={pending}
          onChange={() => {
            setVersion((version) => version + 1);
          }}
        />
      ) : (
        <CreateForm
          onUncertain={() => {
            setVersion((version) => version + 1);
          }}
        />
      )}
    </Box>
  );
}

function CreateForm({ onUncertain }: { onUncertain: () => void }) {
  const { api } = useSession();
  const store = usePendingStore();
  const navigate = useNavigate();
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [card, setCard] = useState<TestToken>('pm_card_visa');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isActive = useIsActive();

  const cents = parseAmount(amount);
  const trimmed = reference.trim();
  const amountProblem = cents === null ? 'Enter an amount from $0.01 to $1,000,000.00.' : null;
  const referenceProblem = trimmed === '' ? 'Enter your reference, such as an order number.' : null;

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (cents === null || referenceProblem) return;
    const input: CreateInput = { amount: cents, reference: trimmed, paymentMethod: card };
    setSubmitting(true);
    setError(null);
    const result = await submitCreate(api, store, input, {
      key: crypto.randomUUID(),
      now: new Date(),
      isActive,
    });
    if (result.kind === 'left') return;
    if (result.kind === 'done' || result.kind === 'unresolved') {
      void navigate(`/payments/${encodeURIComponent(result.body.payment.id)}`);
      return;
    }
    setSubmitting(false);
    if (result.kind === 'not_saved') setError(NOT_SAVED_TEXT);
    else if (result.kind === 'refused') setError(describeRefusal(result.error));
    else onUncertain();
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
      sx={{ display: 'grid', gap: 3 }}
    >
      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}
      <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { sm: '200px 1fr' } }}>
        <TextField
          label="Amount (USD)"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
          required
          autoFocus
          error={touched && amountProblem !== null}
          helperText={
            touched && amountProblem ? amountProblem : cents ? formatAmount(cents, 'USD') : ' '
          }
          slotProps={{ htmlInput: { inputMode: 'decimal', autoComplete: 'off' } }}
        />
        <TextField
          label="Reference"
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
          required
          error={touched && referenceProblem !== null}
          helperText={
            touched && referenceProblem ? referenceProblem : 'Shown in your list and searchable.'
          }
          slotProps={{ htmlInput: { maxLength: 100, autoComplete: 'off' } }}
        />
      </Box>

      <FormControl>
        <FormLabel id="card-label" sx={{ color: 'text.primary', fontWeight: 560, mb: 1 }}>
          Test card
        </FormLabel>
        <RadioGroup
          aria-labelledby="card-label"
          value={card}
          onChange={(event) => {
            setCard(event.target.value as TestToken);
          }}
          sx={{ display: 'grid', gap: 1 }}
        >
          {CARDS.map((option) => (
            <FormControlLabel
              key={option.token}
              value={option.token}
              control={<Radio />}
              sx={{
                m: 0,
                pr: 2,
                py: 0.5,
                border: `1px solid ${card === option.token ? tokens.ink : tokens.rule}`,
                borderRadius: 1.5,
                bgcolor: tokens.surface,
                alignItems: 'flex-start',
                '& .MuiRadio-root': { mt: 0.25 },
              }}
              label={
                <Box sx={{ py: 1 }}>
                  <Typography sx={{ fontWeight: 560 }}>{option.card}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {option.outcome}
                  </Typography>
                </Box>
              }
            />
          ))}
        </RadioGroup>
        <FormHelperText sx={{ mx: 0 }}>
          Each card always does the same thing, so you can try every path a payment can take.
        </FormHelperText>
      </FormControl>

      <Box>
        <Button type="submit" variant="contained" size="large" disabled={submitting}>
          {submitting
            ? 'Creating…'
            : cents
              ? `Create ${formatAmount(cents, 'USD')} payment`
              : 'Create payment'}
        </Button>
      </Box>
    </Box>
  );
}

/** A create that hasn't got a definite answer: finish it with the same key, or look at it. */
function PendingCreate({ pending, onChange }: { pending: CreateRecord; onChange: () => void }) {
  const { api } = useSession();
  const store = usePendingStore();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const isActive = useIsActive();
  const [error, setError] = useState<string | null>(null);
  const what = `${formatAmount(pending.input.amount, 'USD')} for ${pending.input.reference}`;

  if (pending.paymentId) {
    const paymentId = pending.paymentId;
    return (
      <Alert
        severity="info"
        action={
          <Button
            color="inherit"
            size="small"
            sx={{ whiteSpace: 'nowrap' }}
            onClick={() => void navigate(`/payments/${encodeURIComponent(paymentId)}`)}
          >
            View it
          </Button>
        }
      >
        The payment you started, {what}, is still being confirmed with the bank. You can take a new
        payment once it has an outcome.
      </Alert>
    );
  }

  const sendAgain = async () => {
    setSending(true);
    setError(null);
    const result = await finishCreate(api, store, pending, isActive);
    if (result.kind === 'left') return;
    setSending(false);
    if (result.kind === 'done' || result.kind === 'unresolved') {
      void navigate(`/payments/${encodeURIComponent(result.body.payment.id)}`);
    } else if (result.kind === 'refused') {
      setError(describeRefusal(result.error));
      onChange();
    } else {
      setError('Still no answer. Check your connection and try again.');
    }
  };

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Alert severity="warning">
        Your payment of {what} didn’t get an answer, so it may or may not have been created. Sending
        it again can’t charge twice: the platform recognizes the same request.
      </Alert>
      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button variant="contained" disabled={sending} onClick={() => void sendAgain()}>
          {sending ? 'Sending…' : 'Send it again'}
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary">
        A new payment can be taken once this one has an answer. Until then it is only ever sent
        again as the same request, so it can’t create a second payment.
      </Typography>
    </Box>
  );
}

function describeRefusal(error: ApiRequestError): string {
  const fields = error.details?.fields;
  if (error.code === 'VALIDATION_ERROR' && fields?.length) {
    return `Check the form: ${fields.map((field) => `${field.field} ${field.issue}`).join('; ')}.`;
  }
  return refusalText('create', error);
}
