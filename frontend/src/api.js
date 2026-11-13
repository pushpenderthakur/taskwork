/**
 * API client.
 *
 * One axios instance for the whole app: it attaches the bearer token, sends the
 * session cookies and transparently refreshes an expired access token once. The
 * SPA keeps only the access token and the cached user in localStorage — the
 * refresh token is an httpOnly cookie the JavaScript cannot read.
 */
import axios from 'axios';
import { API_URL } from './config';

const TOKEN_STORAGE_KEY = 'taskwork.token';
const USER_STORAGE_KEY = 'taskwork.user';

export const api = axios.create({
  // Empty in mock mode: relative URLs then hit the dev server.
  baseURL: API_URL || undefined,
  // Required for the refresh/logout cookies.
  withCredentials: true,
  timeout: 15000,
});

// Attach the short-lived access token to every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Concurrent 401s share one refresh call instead of racing.
let refreshInFlight = null;

function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = api.post('/refresh').finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Persists the session after a successful sign-in. */
export function saveSession({ accessToken, user } = {}) {
  if (accessToken) localStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
  if (user) localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
}

/** Cached user, or null when missing or corrupted. */
export function getStoredUser() {
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// On a 401: refresh once, retry the original request, and sign out if the
// refresh itself fails. The `/refresh` route is excluded to avoid a loop.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;
    const isRefreshRequest = config?.url?.includes('/refresh');

    if (response?.status !== 401 || !config || config._retried || isRefreshRequest) {
      return Promise.reject(error);
    }

    config._retried = true;
    try {
      const { data } = await refreshSession();
      saveSession(data);
      config.headers = { ...config.headers, Authorization: `Bearer ${data.accessToken}` };
      return api.request(config);
    } catch {
      clearSession();
      return Promise.reject(error);
    }
  },
);

/** Server error message, a network hint, or a caller-supplied fallback. */
export function apiErrorMessage(error, fallback) {
  const serverMessage = error?.response?.data?.error?.message;
  if (serverMessage) return serverMessage;

  // No response at all means the API itself is unreachable (wrong URL, not
  // running, or offline) — say so instead of "please try again".
  if (error?.request && !error?.response) {
    return `Cannot reach the API at ${API_URL || 'the configured URL'}. Is the server running?`;
  }

  return error?.message ?? fallback;
}