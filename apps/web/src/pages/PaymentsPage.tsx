import Typography from '@mui/material/Typography';

/** The payment list (step 17 fills it in). */
export function PaymentsPage() {
  return (
    <>
      <Typography variant="h2" component="h1" sx={{ mb: 1.5 }}>
        Payments
      </Typography>
      <Typography color="text.secondary">Payments you take appear here, newest first.</Typography>
    </>
  );
}
