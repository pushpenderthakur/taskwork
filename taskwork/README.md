# Taskwork

React + Vite + Tailwind CSS v4 auth starter (email/phone OTP, Google and Apple sign-in).

## Getting started

```bash
cd taskwork
npm install
npm run dev
```

`npm run dev` also works from the repository root (`C:\taskwork`), where a thin
`package.json` delegates to the app.

## Environment

Copy `.env.example` to `.env` and fill in the values:

| Variable                 | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `VITE_API_BASE_URL`      | Base URL of the auth API, e.g. `http://localhost:5000/api/auth`.    |
| `VITE_GOOGLE_CLIENT_ID`  | Google OAuth client ID. Leave the placeholder to disable Google.    |
| `VITE_APPLE_CLIENT_ID`   | Apple Services ID (web client_id). Same value as `APPLE_CLIENT_ID`. |

When `VITE_API_BASE_URL` is empty the form runs in mock mode (simulated delay,
no network calls). When `VITE_GOOGLE_CLIENT_ID` or `VITE_APPLE_CLIENT_ID` is
missing or still the placeholder, that provider's button shows an info message
instead of loading its SDK.

Apple sign-in uses Apple's JS SDK in a popup, so the app origin must be
registered as a Return URL of the Services ID and served over HTTPS (Apple does
not allow `localhost`). The token is verified by the server (`POST /auth/apple`).

## API contract

Base URL: `VITE_API_BASE_URL` (e.g. `http://localhost:5000/api/auth`).

| Method | Endpoint      | Body                                              | Success |
| ------ | ------------- | ------------------------------------------------- | ------- |
| POST   | `/send-otp`   | `{ method, identifier, isLogin, name? }`          | `202`   |
| POST   | `/verify-otp` | `{ method, identifier, otp, name? }`              | `200`   |
| POST   | `/refresh`    | refresh cookie                                    | `200`   |
| POST   | `/logout`     | refresh cookie                                    | `200`   |
| POST   | `/logout-all` | bearer                                            | `200`   |
| GET    | `/me`         | bearer                                            | `200`   |
| GET    | `/sessions`   | bearer                                            | `200`   |
| POST   | `/google`     | `{ token }` (Google access token)                 | `200`   |
| POST   | `/apple`      | `{ identityToken, name? }` (Apple identity token) | `200`   |

`method` is `email` or `phone`; `identifier` is an email address or a 10-digit
phone number. Every sign-in route returns `{ success, accessToken, expiresIn,
user }` and sets `access_token` / `refresh_token` httpOnly cookies. The access
token is kept in `localStorage` under `taskwork.token` and the user under
`taskwork.user` (see `src/api.js`).

With `VITE_API_BASE_URL` empty the form runs in mock mode: simulated delay, no
network calls.

## Scripts

| Command           | Description                       |
| ----------------- | --------------------------------- |
| `npm run dev`     | Start the Vite dev server         |
| `npm run build`   | Production build into `dist/`     |
| `npm run preview` | Preview the production build      |
| `npm run lint`    | Run ESLint                        |
| `npm run test:ui` | Headless-Chrome UI check (dev servers must run) |

## Structure

```
src/
  main.jsx                 # React root, GoogleOAuthProvider (conditional)
  App.jsx                  # Switches between <AuthForm /> and <Dashboard />
  api.js                   # Axios client, 401 refresh retry, session storage
  config.js                # Env access (API_URL, Google/Apple client IDs)
  apple.js                 # Apple JS SDK loader + popup sign-in
  index.css                # Tailwind entry (@import "tailwindcss")
  components/AuthForm.jsx  # Login / register / OTP / social login UI
  components/Dashboard.jsx # Profile, linked providers, active sessions
```

`scripts/ui-check.mjs` drives the built UI in headless Chrome over the DevTools
protocol; run it with `npm run test:ui` while `npm run dev` and the API are up.