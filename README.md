# Taskwork

Full-stack authentication starter: a React SPA and an Express/MongoDB API that
share one session model.

- **Email and phone OTP** — 6-digit codes, hashed at rest, single use, attempt
  limited, TTL enforced. Delivery through Gmail/any SMTP and Twilio, with a
  console fallback for local development.
- **Google and Apple sign-in** — identity tokens verified server side (Google
  `tokeninfo` + audience check, Apple JWKS/issuer/audience).
- **Sessions** — short-lived JWT access token, opaque rotating refresh token
  stored as a SHA-256 hash with reuse detection, per-device session list, sign
  out and sign out everywhere.

| Path        | Contents                                                          |
| ----------- | ----------------------------------------------------------------- |
| `taskwork/` | React 19 + Vite + Tailwind v4 SPA (`npm run dev`, port 5173)       |
| `server/`   | Express 5 + Mongoose API (`npm run dev:server`, port 5000)         |
| root        | Scripts that drive both, `docker-compose.yml` for MongoDB          |

## Requirements

- Node.js 20+
- MongoDB — local install, Atlas, or `docker compose up -d`

## Quick start

```bash
npm install                       # root dev deps (concurrently)
npm --prefix server install
npm --prefix taskwork install

cp server/.env.example server/.env
cp taskwork/.env.example taskwork/.env

npm run db:up                      # optional: MongoDB in Docker
npm run dev:all                    # API on :5000, SPA on :5173
```

`npm run db:dev` starts a MongoDB that keeps its data in `server/.data/mongo`
using the `mongodb-memory-server` binary, if you would rather not run Docker.

## Configuration

`server/.env` holds the secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
Mongo URI, `CLIENT_ORIGIN`) and the optional delivery credentials.
`taskwork/.env` holds `VITE_API_BASE_URL` plus the Google/Apple client IDs.
Both files are git-ignored; `.env.example` documents every variable.

Google needs `GOOGLE_CLIENT_ID` (server) and `VITE_GOOGLE_CLIENT_ID` (SPA).
Apple needs the Services ID as `APPLE_CLIENT_ID` and `VITE_APPLE_CLIENT_ID`,
with the app's HTTPS origin registered as a Return URL — Apple does not allow
`localhost`. Without the matching client ID each provider's button shows a
configuration hint instead of opening a popup.

Email and SMS credentials are optional: without them OTP codes are printed to
the server console and returned as `devCode` outside production, so the whole
flow stays testable locally. See [`server/README.md`](server/README.md) for the
Gmail App Password and Twilio setup.

## Scripts

Run from the repository root:

| Command            | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `npm run dev`      | Start the SPA dev server                                |
| `npm run dev:server` | Start the API with `node --watch`                     |
| `npm run dev:all`  | Start API and SPA together                              |
| `npm run build`    | Production build of the SPA into `taskwork/dist`        |
| `npm run lint`     | ESLint over the SPA                                     |
| `npm run preview`  | Serve the built SPA                                     |
| `npm run test:api` | API smoke suite (in-memory MongoDB, no services needed) |
| `npm run test:ui`  | Headless-Chrome UI check against the running dev servers |
| `npm run db:up`    | `docker compose up -d` (MongoDB)                        |
| `npm run db:down`  | `docker compose down`                                   |
| `npm run db:dev`   | MongoDB from the `mongodb-memory-server` binary          |

## Tests

```bash
npm run test:api    # 65 checks: OTP, sessions, Apple, Gmail, Twilio, guards
```

The smoke suite boots an in-memory MongoDB, starts the real Express app, signs
Apple tokens with a throwaway key served from a local JWKS, and speaks SMTP and
the Twilio API to local sinks, so it needs no external accounts.

`npm run test:ui` drives the SPA in headless Chrome over the DevTools protocol
and needs both dev servers running (and a Chrome/Edge binary; set `CHROME_PATH`
to override).

## Deployment notes

- Set strong `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` (≥ 32 chars); production
  refuses to start without them.
- Cookies are `httpOnly` with `secure` and `sameSite: 'none'` in production, so
  the SPA and the API must be served from the same site (e.g.
  `app.example.com` and `api.example.com` share `example.com`), over HTTPS.
- `CLIENT_ORIGIN` is the CORS allow-list; list every browser origin, comma
  separated.
- The API sets a CSP that allows the Google and Apple SDKs. Whatever serves the
  built SPA must send the same policy, otherwise the social buttons are blocked
  by the browser.
- Configure Gmail/transactional email and Twilio before launch; the console
  fallback is development-only.