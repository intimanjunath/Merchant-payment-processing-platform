import { Navigate, Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { RequireSession } from './components/RequireSession';
import { PaymentsPage } from './pages/PaymentsPage';
import { SignInPage } from './pages/SignInPage';

export function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      <Route
        element={
          <RequireSession>
            <AppShell />
          </RequireSession>
        }
      >
        <Route index element={<PaymentsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
