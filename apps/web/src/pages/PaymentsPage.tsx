import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';

import { PaymentTable } from '../components/PaymentTable';
import { ApiRequestError } from '../lib/api';
import {
  isPaymentState,
  normalizeSearch,
  PAYMENT_STATES,
  type PaymentState,
  SEARCH_MAX_LENGTH,
  STATE_LABELS,
} from '../lib/payments';
import { usePaymentList } from '../lib/use-payment-list';
import { tokens } from '../theme';

const PAGE_SIZES = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

function pageSizeFrom(value: string | null): number {
  const size = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE;
}

/**
 * The merchant's payments, newest first. Status, search and page size live in
 * the URL, so a reload or a shared link keeps them. Paging and loading are
 * the PaymentListController's: any filter change starts over at the newest page.
 */
export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status: PaymentState | null = isPaymentState(rawStatus) ? rawStatus : null;
  const q = normalizeSearch(params.get('q'));
  const limit = pageSizeFrom(params.get('limit'));

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [name, value] of Object.entries(changes)) {
            if (value === null) next.delete(name);
            else next.set(name, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The search box follows the URL (back and forward buttons) but updates it only after a pause.
  const [draft, setDraft] = useState(q ?? '');
  const [draftFor, setDraftFor] = useState(q);
  if (draftFor !== q) {
    setDraftFor(q);
    if (normalizeSearch(draft) !== q) setDraft(q ?? '');
  }
  useEffect(() => {
    const next = normalizeSearch(draft);
    if (next === q) return;
    const timer = setTimeout(() => {
      update({ q: next });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, q, update]);

  const list = usePaymentList({ status, q, limit });
  const { result, pageIndex } = list.state;
  // Older and Newer keep the last page (dimmed) while the next loads, so the table doesn't flash;
  // new filters and errors show no rows, since those rows answered a different query.
  const page =
    result.status === 'ready' ? result.page : result.status === 'loading' ? result.previous : null;
  const filtered = status !== null || q !== null;

  const clearFilters = () => {
    setDraft('');
    update({ status: null, q: null });
  };

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
          mb: 1,
        }}
      >
        <Typography variant="h2" component="h1">
          Payments
        </Typography>
        <Button component={RouterLink} to="/payments/new" variant="contained">
          New payment
        </Button>
      </Box>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Newest first. Search by your reference, or narrow the list to one status.
      </Typography>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start', mb: 2 }}>
        <TextField
          label="Search references"
          type="search"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          slotProps={{ htmlInput: { maxLength: SEARCH_MAX_LENGTH } }}
          sx={{ flex: '1 1 260px', maxWidth: { sm: 420 } }}
        />
        <TextField
          select
          label="Rows per page"
          value={limit}
          onChange={(event) => {
            const size = Number(event.target.value);
            update({ limit: size === DEFAULT_PAGE_SIZE ? null : String(size) });
          }}
          sx={{ flex: '0 0 150px' }}
        >
          {PAGE_SIZES.map((size) => (
            <MenuItem key={size} value={size}>
              {size}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      <Box
        role="group"
        aria-label="Filter by status"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 3 }}
      >
        {[null, ...PAYMENT_STATES].map((state) => {
          const selected = state === status;
          return (
            <Chip
              key={state ?? 'all'}
              label={state ? STATE_LABELS[state] : 'All'}
              aria-pressed={selected}
              variant={selected ? 'filled' : 'outlined'}
              onClick={() => {
                update({ status: state });
              }}
              sx={{
                fontWeight: 560,
                borderColor: tokens.rule,
                ...(selected && { bgcolor: tokens.ink, color: tokens.surface }),
                '&&:hover': selected ? { bgcolor: tokens.ink } : {},
              }}
            />
          );
        })}
      </Box>

      {result.status === 'error' && <ListError error={result.error} onRetry={list.retry} />}

      {/* A first load that failed shows only the error; there is nothing to frame. */}
      {(page !== null || result.status === 'loading') && (
        <Box
          sx={{
            position: 'relative',
            bgcolor: tokens.surface,
            border: `1px solid ${tokens.rule}`,
            borderRadius: 1.5,
            px: { xs: 2, sm: 0 },
          }}
        >
          <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3 }}>
            {result.status === 'loading' && page && (
              <LinearProgress aria-label="Loading payments" sx={{ height: 3 }} />
            )}
          </Box>
          {result.status === 'ready' && result.page.items.length === 0 ? (
            <EmptyList filtered={filtered} onClear={clearFilters} />
          ) : (
            <Box
              aria-busy={result.status === 'loading'}
              sx={{ opacity: result.status === 'loading' && page ? 0.55 : 1 }}
            >
              <PaymentTable
                payments={page?.items ?? []}
                skeletonRows={!page && result.status === 'loading' ? 5 : 0}
              />
            </Box>
          )}
        </Box>
      )}

      {page && (pageIndex > 0 || page.nextCursor) && (
        <Box
          component="nav"
          aria-label="Pages"
          sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 2, flexWrap: 'wrap' }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 160 }}>
            {result.status === 'ready'
              ? rangeLabel(pageIndex, limit, page.items.length)
              : 'Loading…'}
          </Typography>
          <Button
            variant="outlined"
            color="inherit"
            disabled={pageIndex === 0 || result.status === 'loading'}
            onClick={list.newer}
          >
            Newer payments
          </Button>
          <Button
            variant="outlined"
            color="inherit"
            disabled={!page.nextCursor || result.status !== 'ready'}
            onClick={list.older}
          >
            Older payments
          </Button>
        </Box>
      )}
    </>
  );
}

function rangeLabel(pageIndex: number, limit: number, count: number): string {
  if (count === 0) return 'No payments on this page';
  const first = pageIndex * limit + 1;
  return `Payments ${String(first)} to ${String(first + count - 1)}`;
}

function EmptyList({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <Box sx={{ py: 6, px: { xs: 0, sm: 3 }, textAlign: 'center' }}>
      <Typography variant="h4" component="h2" sx={{ mb: 1 }}>
        {filtered ? 'No payments match' : 'No payments yet'}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: filtered ? 2.5 : 0 }}>
        {filtered
          ? 'Nothing has this status or a reference containing your search.'
          : 'Payments you take appear here, newest first.'}
      </Typography>
      {filtered && (
        <Button variant="outlined" color="inherit" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </Box>
  );
}

function ListError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const known = error instanceof ApiRequestError ? error : null;
  return (
    <Alert
      severity="error"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      Payments didn’t load. {known?.message ?? 'Something went wrong in the dashboard.'}
      {known?.requestId && (
        <Typography variant="body2" component="span" sx={{ display: 'block', mt: 0.5 }}>
          Request ID {known.requestId}
        </Typography>
      )}
    </Alert>
  );
}
