/**
 * React entry point.
 *
 * The Google OAuth context is only mounted when a client ID is configured, so a
 * missing `VITE_GOOGLE_CLIENT_ID` cannot crash the app — the button then renders
 * as a hint instead.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import './index.css';
import App from './App.jsx';
import { GOOGLE_CLIENT_ID, isGoogleConfigured } from './config.js';

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

createRoot(document.getElementById('root')).render(
  isGoogleConfigured ? (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>{app}</GoogleOAuthProvider>
  ) : (
    app
  ),
);