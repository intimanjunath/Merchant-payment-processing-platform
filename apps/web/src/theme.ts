import { createTheme } from '@mui/material/styles';

/**
 * Cool, paper-like ground with blue-slate ink: a teller's window, not a
 * marketing page. One typeface, sentence case everywhere, flat surfaces
 * separated by rules rather than shadows. Tabular figures are applied only
 * where numbers line up (amounts): in this typeface the feature also widens
 * commas and full stops, which looks wrong in running text.
 */
export const tokens = {
  ground: '#EEF2F1',
  surface: '#FFFFFF',
  ink: '#18283A',
  inkMuted: '#5B6B74',
  rule: '#C5D0CD',
  note: '#1C6B57',
  alert: '#A8382F',
} as const;

const fontFamily = "'Schibsted Grotesk Variable', 'Helvetica Neue', Arial, sans-serif";

export const theme = createTheme({
  palette: {
    background: { default: tokens.ground, paper: tokens.surface },
    text: { primary: tokens.ink, secondary: tokens.inkMuted },
    primary: { main: tokens.note, contrastText: '#FFFFFF' },
    error: { main: tokens.alert },
    // Notices (signed out, session ended) in the ink's own blue-slate, not a stock blue.
    info: { main: '#3B5B73' },
    // Server trouble (not the merchant's mistake): a muted amber, not a stock orange.
    warning: { main: '#8A5A12' },
    divider: tokens.rule,
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily,
    fontWeightRegular: 420,
    fontWeightMedium: 520,
    fontWeightBold: 640,
    // A 1.25 scale from a 16 px body.
    h1: { fontSize: '2.4375rem', fontWeight: 640, lineHeight: 1.15, letterSpacing: '-0.015em' },
    h2: { fontSize: '1.9375rem', fontWeight: 640, lineHeight: 1.2, letterSpacing: '-0.01em' },
    h3: { fontSize: '1.5625rem', fontWeight: 600, lineHeight: 1.25 },
    h4: { fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.3 },
    body1: { fontSize: '1rem', lineHeight: 1.55 },
    body2: { fontSize: '0.875rem', lineHeight: 1.5 },
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiTextField: { defaultProps: { fullWidth: true } },
    MuiCssBaseline: {
      styleOverrides: {
        '*:focus-visible': { outline: `2px solid ${tokens.note}`, outlineOffset: 2 },
        '@media (prefers-reduced-motion: reduce)': {
          '*': { transitionDuration: '0.01ms !important', animationDuration: '0.01ms !important' },
        },
      },
    },
  },
});
