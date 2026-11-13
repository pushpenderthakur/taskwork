import axios from 'axios';
import { API_URL } from './config';

const TOKEN_STORAGE_KEY = 'taskwork.token';
const USER_STORAGE_KEY = 'taskwork.user';

export const api = axios.create({
  baseURL: API_URL || undefined,
  withCredentials: true,
  timeout: 15000,
});

// Bearer token for the short lived access token; the refresh token lives in an
// httpOnly cookie that the browser sends automatically.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshInFlight = null;

function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = api.post('/refresh').finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export function saveSession({ accessToken, user } = {}) {
  if (accessToken) localStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
  if (user) localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
}

export function getStoredUser() {
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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

export function apiErrorMessage(error, fallback) {
  return error?.response?.data?.error?.message ?? fallback;
}