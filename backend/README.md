# Taskwork API

Authentication API for the Taskwork web app: email/phone OTP, Google and Apple
sign-in, and JWT session management backed by MongoDB.

## Requirements

- Node.js 20+
- MongoDB (local, Atlas, or `docker compose up -d` from the repo root)

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then edit the values
npm run dev               # http://localhost:5000
```

`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must be at least 32 characters in
production (`openssl rand -hex 32`). In development the server falls back to
ephemeral secrets and warns on startup.

## Endpoints

Base URL: `http://localhost:5000/api`

| Method | Path             | Auth   | Body                                                     | Success |
| ------ | ---------------- | ------ | -------------------------------------------------------- | ------- |
| GET    | `/health`        | –      | –                                                        | `200`   |
| POST   | `/auth/send-otp` | –      | `{ method, identifier, isLogin, name? }`                 | `202`   |
| POST   | `/auth/verify-otp` | –    | `{ method, identifier, otp, name? }`                     | `200`   |
| POST   | `/auth/refresh`  | cookie | –                                                        | `200`   |
| POST   | `/auth/logout`   | cookie | –                                                        | `200`   |
| POST   | `/auth/logout-all` | bearer | –                                                      | `200`   |
| GET    | `/auth/sessions` | bearer | –                                                        | `200`   |
| GET    | `/auth/me`       | bearer | –                                                        | `200`   |
| POST   | `/auth/google`   | –      | `{ token }` (Google access token)                        | `200`   |
| POST   | `/auth/apple`    | –      | `{ identityToken, name? }` (`name` may be `{ firstName, lastName }`) | `200`   |

`method` is `email` or `phone`. `identifier` is an email address or a 10-digit
phone number. `isLogin: false` registers, `isLogin: true` signs in.

### OAuth setup

`GOOGLE_CLIENT_ID` must equal the frontend `VITE_GOOGLE_CLIENT_ID`. Apple needs
an `APPLE_CLIENT_ID` (the Services ID used by Sign in with Apple) that matches
the frontend `VITE_APPLE_CLIENT_ID`; identity tokens are verified against
Apple's JWKS (`APPLE_JWKS_URL`) with issuer `APPLE_ISSUER`. Until it is set,
`POST /auth/apple` answers `503 APPLE_NOT_CONFIGURED`. Apple shares the user's
name only on the first authorisation, so the client sends `name` with that one
sign-in; later sign-ins match the existing account by the token subject.

### Session responses

`send-otp`, `verify-otp`, `refresh` and the OAuth routes return:

```json
{
  "success": true,
  "accessToken": "eyJ...",
  "expiresIn": 604800,
  "user": {
    "id": "…",
    "name": "New User",
    "email": "new.user@example.com",
    "phone": null,
    "emailVerified": true,
    "phoneVerified": false,
    "providers": { "google": false, "apple": false }
  }
}
```

`access_token` and `refresh_token` are also set as httpOnly cookies
(`refresh_token` is scoped to `/api/auth`). The access token is a JWT valid for
15 minutes; the refresh token is opaque, stored as a SHA-256 hash, rotated on
every refresh, and reusing a rotated token revokes the whole session family.
Each session records its user agent and IP; `GET /auth/sessions` lists them and
`POST /auth/logout-all` revokes every one of them.

In non-production, when no email/SMS provider is configured, `send-otp` also
returns `devCode` so the flow can be completed locally without SMTP.

### Errors

```json
{ "error": { "code": "ACCOUNT_EXISTS", "message": "An account with this email already exists." } }
```

| Status | Codes                                                                                    |
| ------ | ---------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `OTP_NOT_FOUND`, `OTP_EXPIRED`, `OTP_ALREADY_USED`, `OTP_INVALID`    |
| 401    | `NO_TOKEN`, `INVALID_TOKEN`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED`, `REFRESH_TOKEN_EXPIRED` |
| 404    | `ACCOUNT_NOT_FOUND`, `ROUTE_NOT_FOUND`                                                   |
| 409    | `ACCOUNT_EXISTS`, `DUPLICATE`                                                            |
| 429    | `RATE_LIMITED`                                                                           |
| 502    | `EMAIL_DELIVERY_FAILED`, `SMS_DELIVERY_FAILED`                                             |
| 503    | `GOOGLE_NOT_CONFIGURED`, `APPLE_NOT_CONFIGURED`, `SMS_NOT_CONFIGURED`                     |

### Email delivery (Gmail)

Email OTP is sent with nodemailer. Gmail needs an **App Password**
(<https://myaccount.google.com/apppasswords>, 2-Step Verification must be on);
a normal account password will not work.

Leave `SMTP_HOST` empty and set only:

```env
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
```

Gmail is then detected automatically: `smtp.gmail.com`, port `465` with implicit
TLS, and the `From` header defaults to the authenticated address. For STARTTLS on
587 set `SMTP_PORT=587` and `SMTP_SECURE=false`. Any other provider works with an
explicit `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE`, or with `SMTP_SERVICE`
(`gmail`, `outlook`, `yahoo`, ...).

Without a transport, `send-otp` logs the code and returns `devCode` outside
production, so the flow stays testable locally. A failed send is reported as
`502 EMAIL_DELIVERY_FAILED` and the unused code is discarded, so the next
`send-otp` is not blocked by the resend cooldown.

Gmail allows roughly 500 recipients per day, so use a transactional provider
(SES, Postmark, Resend) once real traffic arrives.

### SMS delivery (Twilio)

Phone OTP needs a provider; without one the code is logged and returned as
`devCode` outside production. Twilio needs an Account SID, Auth Token and a
sender (phone number or Messaging Service SID):

```env
SMS_PROVIDER=twilio
SMS_COUNTRY_CODE=91
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM=+15005550006
```

Numbers are normalised to E.164 with `SMS_COUNTRY_CODE` (the UI collects 10
digits). A rejected message is `502 SMS_DELIVERY_FAILED` and the unused code is
discarded; `SMS_PROVIDER=twilio` with incomplete credentials is
`503 SMS_NOT_CONFIGURED`.

## Security notes

- Passwords are not used: accounts are created from a verified email/phone.
- OTPs are 6 digits, bcrypt-hashed at rest, valid 5 minutes, single use, max 5
  verification attempts, 30 second resend cooldown, TTL index for cleanup.
- `helmet`, CORS allow-list, JSON body size limit, and per-route rate limits.
- Emails are sent with nodemailer when SMTP is configured, otherwise the OTP is
  printed to the server console. SMS goes through Twilio when
  `SMS_PROVIDER=twilio`, with the same console fallback otherwise.

## Database

`User` keeps a unique index per email and per phone (partial indexes, so many
accounts can omit one), `emailVerified` / `phoneVerified` flags, linked OAuth
provider ids, and hashed refresh tokens. `Otp` keeps one live code per
destination with a TTL index.

## Tests

```bash
npm run test:smoke
```

Boots an in-memory MongoDB, starts the real app, and exercises the OTP, session
rotation, reuse detection, duplicate-account, Google-rejection and Apple
verification paths over HTTP. The Apple checks sign identity tokens with a
throwaway key served from a local JWKS, so no Apple account is needed.