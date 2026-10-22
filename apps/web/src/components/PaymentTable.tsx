import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';

import { formatAmount, formatCard, type Payment } from '../lib/payments';
import { tokens } from '../theme';
import { PaymentStatus } from './PaymentStatus';

const COLUMN_WIDTHS = ['28%', '24%', '12%', '17%', '19%'];

const created = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Amounts line up digit for digit; only here, since the feature widens punctuation in text.
const figures = { fontVariantNumeric: 'tabular-nums' } as const;

function CreatedAt({ value }: { value: string }) {
  return <time dateTime={value}>{created.format(new Date(value))}</time>;
}

interface PaymentTableProps {
  payments: Payment[];
  /** Placeholder rows while the first page loads. */
  skeletonRows?: number;
}

/** Payments as a table, or as stacked rows on narrow screens. */
export function PaymentTable({ payments, skeletonRows = 0 }: PaymentTableProps) {
  const narrow = useMediaQuery(useTheme().breakpoints.down('sm'));
  return narrow ? (
    <NarrowList payments={payments} skeletonRows={skeletonRows} />
  ) : (
    <WideTable payments={payments} skeletonRows={skeletonRows} />
  );
}

function WideTable({ payments, skeletonRows }: Required<PaymentTableProps>) {
  const head = { color: 'text.secondary', fontWeight: 560, borderColor: tokens.rule };
  const cell = { borderColor: tokens.rule, verticalAlign: 'top', py: 1.75 };
  return (
    // Fixed widths: the columns stay put when a filter or page changes what's in them.
    <Table aria-label="Payments" sx={{ tableLayout: 'fixed' }}>
      <colgroup>
        {COLUMN_WIDTHS.map((width, index) => (
          <col key={index} style={{ width }} />
        ))}
      </colgroup>
      <TableHead>
        <TableRow>
          <TableCell sx={head}>Reference</TableCell>
          <TableCell sx={head}>Status</TableCell>
          <TableCell sx={head} align="right">
            Amount
          </TableCell>
          <TableCell sx={head}>Card</TableCell>
          <TableCell sx={head}>Created</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {payments.map((payment) => (
          <TableRow key={payment.id}>
            <TableCell sx={{ ...cell, fontWeight: 560, overflowWrap: 'anywhere' }}>
              {payment.reference}
            </TableCell>
            <TableCell sx={cell}>
              <PaymentStatus payment={payment} />
            </TableCell>
            <TableCell sx={{ ...cell, ...figures }} align="right">
              {formatAmount(payment.amount, payment.currency)}
            </TableCell>
            <TableCell sx={{ ...cell, color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {formatCard(payment.paymentMethod)}
            </TableCell>
            <TableCell sx={{ ...cell, color: 'text.secondary', whiteSpace: 'nowrap' }}>
              <CreatedAt value={payment.createdAt} />
            </TableCell>
          </TableRow>
        ))}
        {Array.from({ length: skeletonRows }, (_, index) => (
          <TableRow key={`skeleton-${String(index)}`} aria-hidden>
            {[40, 22, 12, 14, 16].map((width, column) => (
              <TableCell key={column} sx={cell}>
                <Skeleton width={`${String(width * 2)}%`} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NarrowList({ payments, skeletonRows }: Required<PaymentTableProps>) {
  const row = { py: 2, borderBottom: `1px solid ${tokens.rule}` };
  return (
    <Box component="ul" aria-label="Payments" sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {payments.map((payment) => (
        <Box component="li" key={payment.id} sx={row}>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline' }}>
            <Typography sx={{ fontWeight: 560, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              {payment.reference}
            </Typography>
            <Typography sx={{ ...figures, fontWeight: 560 }}>
              {formatAmount(payment.amount, payment.currency)}
            </Typography>
          </Box>
          <Box sx={{ mt: 0.75 }}>
            <PaymentStatus payment={payment} />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            {formatCard(payment.paymentMethod)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            <CreatedAt value={payment.createdAt} />
          </Typography>
        </Box>
      ))}
      {Array.from({ length: skeletonRows }, (_, index) => (
        <Box component="li" key={`skeleton-${String(index)}`} aria-hidden sx={row}>
          <Skeleton width="70%" />
          <Skeleton width="40%" />
          <Skeleton width="50%" />
        </Box>
      ))}
    </Box>
  );
}
