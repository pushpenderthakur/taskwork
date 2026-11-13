/**
 * Root component.
 *
 * Switches between the auth form and the dashboard based on the cached user in
 * localStorage. The cache is only a UI hint: every protected API call is
 * authorised by the token, and a 401 clears it (see `api.js`).
 */
import { useEffect, useState } from 'react';
import AuthForm from './components/AuthForm';
import Dashboard from './components/Dashboard';
import { clearSession, getStoredUser, SIGNED_OUT_EVENT } from './api';

function App() {
  const [user, setUser] = useState(() => getStoredUser());

  // A failed refresh means the session is gone server side, so the cached user
  // in state must go too (the API client clears localStorage itself).
  useEffect(() => {
    const handleSignedOut = () => setUser(null);
    window.addEventListener(SIGNED_OUT_EVENT, handleSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, handleSignedOut);
  }, []);

  // Dashboard sign-out: drop the cached session and return to the form.
  const handleSignedOut = () => {
    clearSession();
    setUser(null);
  };

  if (user) {
    return <Dashboard user={user} onSignedOut={handleSignedOut} />;
  }

  return <AuthForm onAuthenticated={setUser} />;
}

export default App;