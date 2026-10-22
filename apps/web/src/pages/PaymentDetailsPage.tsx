import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { Link as RouterLink, useLocation, useParams } from 'react-router';

import { LifecycleRail } from '../components/LifecycleRail';
import { PaymentActions } from '../components/PaymentActions';
import { PaymentStatus } from '../components/PaymentStatus';
import { ApiRequestError } from '../lib/api';
import {
  ACTION_LABELS,
  ACTION_NOUNS,
  actorLabel,
  formatAmount,
  formatCard,
  formatDateTime,
  type FromList,
  isUnresolved,
  type Operation,
  OPERATION_STATUS_LABELS,
  type PaymentDetails,
  reachedAt,
  reasonLabel,
  STATE_LABELS,
  type Transition,
} from '../lib/payments';
import { usePaymentActions } from '../lib/use-payment-actions';
import { usePaymentDetails } from '../lib/use-payment-details';
import { tokens } from '../theme';

/** The route element: one details view per payment ID, so each gets its own poller. */
export function PaymentDetailsPage() {
  const { paymentId = '' } = useParams();
  return <DetailsView key={paymentId} paymentId={paymentId} />;
}

function BackLink() {
  const location = useLocation();
  const search = (location.state as Partial<FromList> | null)?.listSearch;
  const to = typeof search === 'string' && search.startsWith('?') ? `/${search}` : '/';
  return (
    <Link component={RouterLink} to={to} underline="hover" sx={{ fontWeight: 560 }}>
      Back to payments
    </Link>
  );
}

function DetailsView({ paymentId }: { paymentId: string }) {
  const { state, refresh } = usePaymentDetails(paymentId);
  const actions = usePaymentActions(
    paymentId,
    state.status === 'ready' ? state.details : null,
    refresh,
  );

  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <Box aria-busy aria-label="Loading payment">
        <Skeleton width="40%" height={48} />
        <Skeleton width="25%" />
        <Skeleton variant="rectangular" height={160} sx={{ mt: 4, borderRadius: 1.5 }} />
      </Box>
    );
  } else if (state.status === 'not_found') {
    body = (
      <>
        <Typography variant="h2" component="h1" sx={{ mb: 1 }}>
          Payment not found
        </Typography>
        <Typography color="text.secondary">
          There’s no payment with this address in your account. Check the link, or find the payment
          in your list.
        </Typography>
      </>
    );
  } else if (state.status === 'error') {
    const known = state.error instanceof ApiRequestError ? state.error : null;
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={refresh}>
            Try again
          </Button>
        }
      >
        This payment didn’t load. {known?.message ?? 'Something went wrong in the dashboard.'}
        {known?.requestId && (
          <Typography variant="body2" component="span" sx={{ display: 'block', mt: 0.5 }}>
            Request ID {known.requestId}
          </Typography>
        )}
      </Alert>
    );
  } else {
    body = (
      <Details
        details={state.details}
        refreshFailed={state.refreshFailed}
        actions={
          <PaymentActions
            details={state.details}
            actions={actions.state}
            onStart={actions.start}
            onRetry={actions.retry}
          />
        }
      />
    );
  }

  return (
    <>
      <Box sx={{ mb: 3 }}>
        <BackLink />
      </Box>
      {body}
    </>
  );
}

function Details({
  details,
  refreshFailed,
  actions,
}: {
  details: PaymentDetails;
  refreshFailed: boolean;
  /** Capture or refund, with its messages. */
  actions: ReactNode;
}) {
  const { payment, pendingOperation } = details;
  const live = isUnresolved(details);
  return (
    <>
      <Box
        component="header"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 2,
          mb: 3,
        }}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 320px' }}>
          <Typography variant="h2" component="h1" sx={{ mb: 1.5, overflowWrap: 'anywhere' }}>
            {payment.reference}
          </Typography>
          <PaymentStatus payment={payment} />
        </Box>
        <Box sx={{ textAlign: { sm: 'right' } }}>
          <Typography sx={{ fontSize: '1.9375rem', fontWeight: 640 }}>
            {formatAmount(payment.amount, payment.currency)}
          </Typography>
          <Typography color="text.secondary">{formatCard(payment.paymentMethod)}</Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gap: 1.5, mb: 3 }}>
        {pendingOperation && <PendingNotice operation={pendingOperation} />}
        {payment.settlementReview && (
          <Alert severity="warning">
            Settlement is under review: the bank hasn’t confirmed the funds in time. The payment
            stays captured until the payments team resolves it.
          </Alert>
        )}
        {refreshFailed && (
          <Alert severity="warning">
            Couldn’t check for updates just now. Showing the details as they were; still trying.
          </Alert>
        )}
        {actions}
      </Box>

      <Section>
        <LifecycleRail
          caption="Where this payment is"
          progress={{ state: payment.state, reachedAt: reachedAt(details.transitions) }}
        />
        {live && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
            This page checks for updates every 5 seconds.
          </Typography>
        )}
      </Section>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 3,
          mt: 3,
        }}
      >
        <Section title="History" description="Every change of state, oldest first.">
          <Timeline>
            {details.transitions.map((transition) => (
              <TransitionItem
                key={transition.occurredAt + transition.toState}
                transition={transition}
              />
            ))}
          </Timeline>
        </Section>
        <Section
          title="Requests to the bank"
          description="Each authorize, capture and refund, including rejected and paused ones."
        >
          <Timeline>
            {details.operations.map((operation) => (
              <OperationItem key={operation.id} operation={operation} />
            ))}
          </Timeline>
        </Section>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 3, overflowWrap: 'anywhere' }}>
        Created {formatDateTime(payment.createdAt)}. Payment ID {payment.id}
      </Typography>
    </>
  );
}

/** What the platform is still doing, or why it stopped. */
function PendingNotice({ operation }: { operation: Operation }) {
  const action = ACTION_NOUNS[operation.action];
  if (operation.status === 'needs_review') {
    const why = reasonLabel(operation.reason);
    return (
      <Alert severity="warning">
        The {action} is paused for review{why ? `: ${why.toLowerCase()}` : ''}. Nothing else can
        happen to this payment until the payments team resolves it.
      </Alert>
    );
  }
  return (
    <Alert severity="info">
      The {action} is waiting for the bank to confirm. Nothing needs doing; this page updates by
      itself.
    </Alert>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      sx={{
        bgcolor: tokens.surface,
        border: `1px solid ${tokens.rule}`,
        borderRadius: 1.5,
        p: { xs: 2, sm: 3 },
        minWidth: 0,
      }}
    >
      {title && (
        <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
          {title}
        </Typography>
      )}
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {description}
        </Typography>
      )}
      {children}
    </Box>
  );
}

function Timeline({ children }: { children: ReactNode }) {
  return (
    <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {children}
    </Box>
  );
}

function TimelineItem({
  at,
  title,
  lines,
}: {
  at: string;
  title: string;
  lines: (string | null)[];
}) {
  return (
    <Box
      component="li"
      sx={{
        py: 1.5,
        borderTop: `1px solid ${tokens.rule}`,
        '&:first-of-type': { borderTop: 'none', pt: 0 },
      }}
    >
      <Typography variant="body2" color="text.secondary">
        <time dateTime={at}>{formatDateTime(at)}</time>
      </Typography>
      <Typography sx={{ fontWeight: 560 }}>{title}</Typography>
      {lines
        .filter((line): line is string => line !== null)
        .map((line) => (
          <Typography
            key={line}
            variant="body2"
            color="text.secondary"
            sx={{ overflowWrap: 'anywhere' }}
          >
            {line}
          </Typography>
        ))}
    </Box>
  );
}

function TransitionItem({ transition }: { transition: Transition }) {
  const to = STATE_LABELS[transition.toState];
  const title = transition.fromState
    ? `${STATE_LABELS[transition.fromState]} to ${to}`
    : `Created as ${to.toLowerCase()}`;
  return (
    <TimelineItem
      at={transition.occurredAt}
      title={title}
      lines={[
        reasonLabel(transition.reason) ?? transition.reason,
        actorLabel(transition),
        transition.requestId ? `Request ID ${transition.requestId}` : null,
      ]}
    />
  );
}

function OperationItem({ operation }: { operation: Operation }) {
  const why = reasonLabel(operation.reason);
  return (
    <TimelineItem
      at={operation.createdAt}
      title={`${ACTION_LABELS[operation.action]}: ${OPERATION_STATUS_LABELS[operation.status]}`}
      lines={[
        why,
        operation.completedAt ? `Finished ${formatDateTime(operation.completedAt)}` : null,
      ]}
    />
  );
}
