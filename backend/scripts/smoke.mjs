/**
 * End-to-end smoke test for the auth API.
 * Boots an in-memory MongoDB, starts the real Express app, and exercises the
 * full OTP + session + email-delivery + OAuth flows over HTTP.
 *
 * Run with: npm run test:smoke
 */
import http from 'node:http';
import net from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_that_is_long_enough_0123456789';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_that_is_long_enough_0123456789';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

// A local JWKS lets the Apple identity-token path be verified without Apple.
const APPLE_KID = 'taskwork-test-key';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwks = {
  keys: [{ ...(await exportJWK(publicKey)), kid: APPLE_KID, alg: 'RS256', use: 'sig' }],
};
const jwksServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(jwks));
});
await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));

process.env.APPLE_CLIENT_ID = 'com.taskwork.web';
process.env.APPLE_ISSUER = 'https://appleid.test';
process.env.APPLE_JWKS_URL = `http://127.0.0.1:${jwksServer.address().port}/auth/keys`;

async function appleIdentityToken({
  sub,
  email,
  emailVerified = true,
  issuer = 'https://appleid.test',
  audience = 'com.taskwork.web',
  expiresAt,
} = {}) {
  return new SignJWT({
    email,
    email_verified: emailVerified ? 'true' : 'false',
  })
    .setProtectedHeader({ alg: 'RS256', kid: APPLE_KID })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt ?? Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}

// A stub of Google's tokeninfo/userinfo endpoints, so the Google flow can be
// exercised without a real Google account.
const GOOGLE_CLIENT_ID = 'test-google-client.apps.googleusercontent.com';
const GOOGLE_VALID_TOKEN = 'valid-google-access-token';
const GOOGLE_WRONG_AUDIENCE_TOKEN = 'token-issued-for-another-client';

const googleSink = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/tokeninfo') {
    const token = url.searchParams.get('access_token');
    if (token === GOOGLE_VALID_TOKEN) {
      return json(200, {
        aud: GOOGLE_CLIENT_ID,
        sub: 'google-sub-1',
        scope: 'openid email profile',
      });
    }
    if (token === GOOGLE_WRONG_AUDIENCE_TOKEN) {
      return json(200, {
        aud: 'some-other-client.apps.googleusercontent.com',
        sub: 'google-sub-2',
      });
    }
    return json(400, { error: 'invalid_token' });
  }

  if (url.pathname === '/userinfo') {
    if (req.headers.authorization !== `Bearer ${GOOGLE_VALID_TOKEN}`) {
      return json(401, { error: 'invalid_token' });
    }
    return json(200, {
      sub: 'google-sub-1',
      email: 'Google.User@Example.com',
      email_verified: true,
      name: 'Google User',
    });
  }

  return json(404, { error: 'not_found' });
});

await new Promise((resolve) => googleSink.listen(0, '127.0.0.1', resolve));

process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
process.env.GOOGLE_TOKENINFO_URL = `http://127.0.0.1:${googleSink.address().port}/tokeninfo`;
process.env.GOOGLE_USERINFO_URL = `http://127.0.0.1:${googleSink.address().port}/userinfo`;

const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri('taskwork-smoke');

const { connectDb, disconnectDb } = await import('../src/config/db.js');
const { createApp } = await import('../src/app.js');
const { Otp } = await import('../src/models/Otp.js');
const { generateOtpCode } = await import('../src/utils/otp.js');
const { accessCookieOptions } = await import('../src/utils/tokens.js');
const { env: appEnv } = await import('../src/config/env.js');

// The mailer/sms helpers print the OTP in development; capture it here.
const otpLogPattern = /OTP for .*?(\d{6})/;
let lastOtp = null;
const originalInfo = console.info;
console.info = (...args) => {
  const line = args.join(' ');
  const match = line.match(otpLogPattern);
  if (match) lastOtp = match[1];
  originalInfo(...args);
};

await connectDb({ attempts: 1 });
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  const label = condition ? 'PASS' : 'FAIL';
  console.log(`  [${label}] ${name}${detail && !condition ? ` -> ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  return null;
}

// Minimal SMTP sink so the delivery path can be exercised without credentials.
function startSmtpSink() {
  const messages = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    let message = '';

    socket.write('220 taskwork.test ESMTP\r\n');
    socket.on('error', () => {});

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let newline;
      while ((newline = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(message);
            message = '';
            socket.write('250 2.0.0 queued\r\n');
          } else {
            message += `${line.replace(/^\.\./, '.')}\n`;
          }
          continue;
        }

        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-taskwork.test\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 end with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else socket.write('250 2.0.0 ok\r\n');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, messages, port: server.address().port }),
    );
  });
}

async function call(path, { method = 'GET', body, token, cookie, origin } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  const json = await response.json().catch(() => null);
  return { status: response.status, json, setCookie };
}

function cookieHeader(setCookie) {
  return setCookie.map((entry) => entry.split(';')[0]).join('; ');
}

try {
  console.log('\nAuth API smoke test\n');

  const health = await call('/api/health');
  check('health endpoint returns ok', health.status === 200 && health.json?.status === 'ok');
  check(
    'health reports database connected',
    health.json?.database === 'connected',
    health.json?.database,
  );

  const noToken = await call('/api/auth/me');
  check('GET /me without token is 401', noToken.status === 401, `status ${noToken.status}`);

  // Browsers only ever send `Origin` cross-origin. Origins outside CLIENT_ORIGIN
  // must be refused with a 403 rather than the 500 a throwing cors callback gives.
  const allowedOrigin = process.env.CLIENT_ORIGIN;
  const badOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { origin: 'http://localhost:5174' },
  });
  const badOriginBody = await badOrigin.json().catch(() => null);
  check(
    'an unlisted origin is 403 ORIGIN_NOT_ALLOWED',
    badOrigin.status === 403 && badOriginBody?.error?.code === 'ORIGIN_NOT_ALLOWED',
    `status ${badOrigin.status} ${JSON.stringify(badOriginBody)}`,
  );

  const badPreflight = await fetch(`${baseUrl}/api/auth/send-otp`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:5174',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  check(
    'a preflight from an unlisted origin is 403',
    badPreflight.status === 403,
    `status ${badPreflight.status}`,
  );

  const goodOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: allowedOrigin } });
  check(
    'a listed origin keeps its CORS header',
    goodOrigin.status === 200 &&
      goodOrigin.headers.get('access-control-allow-origin') === allowedOrigin,
    `status ${goodOrigin.status} allow-origin ${goodOrigin.headers.get('access-control-allow-origin')}`,
  );

  const noOrigin = await fetch(`${baseUrl}/api/health`);
  check('a request without an Origin is allowed', noOrigin.status === 200, `status ${noOrigin.status}`);

  // Codes must stay 6 digits (leading zeros included) and come from the CSPRNG,
  // so two draws are effectively never the same.
  const generated = new Set(Array.from({ length: 200 }, () => generateOtpCode()));
  check(
    'generated codes are 6 digits',
    [...generated].every((code) => /^\d{6}$/.test(code)),
    [...generated].find((code) => !/^\d{6}$/.test(code)),
  );
  check('generated codes vary', generated.size > 1, `distinct ${generated.size}`);

  // The access cookie has to expire with the token it carries.
  check(
    'the access cookie matches ACCESS_TOKEN_TTL',
    accessCookieOptions().maxAge === appEnv.accessTokenTtlMs,
    `${accessCookieOptions().maxAge} vs ${appEnv.accessTokenTtlMs}`,
  );

  // On a deployment that serves the SPA and the API from one domain (Vercel),
  // every POST carries the deployment's own Origin, which CLIENT_ORIGIN cannot
  // list in advance. It must still be allowed.
  const sameOrigin = await call('/api/auth/send-otp', {
    method: 'POST',
    origin: baseUrl,
    body: { method: 'email', identifier: 'ghost@example.com', isLogin: true },
  });
  check(
    'a same-origin POST is allowed',
    sameOrigin.status === 404 && sameOrigin.json?.error?.code === 'ACCOUNT_NOT_FOUND',
    `status ${sameOrigin.status} ${JSON.stringify(sameOrigin.json)}`,
  );

  // `ALLOW_DEV_OTP` is the escape hatch for a deployment without a mail provider:
  // codes stay out of responses unless it is explicitly enabled.
  const flagEmail = `otp.flag.${Date.now()}@example.com`;
  appEnv.isProduction = true;
  appEnv.allowDevOtp = false;
  const quiet = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: flagEmail, isLogin: false, name: 'Flag' },
  });
  check(
    'production hides the dev code',
    quiet.status === 202 && !quiet.json?.devCode,
    JSON.stringify(quiet.json),
  );

  appEnv.allowDevOtp = true;
  const echoed = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: flagEmail, isLogin: false, name: 'Flag' },
  });
  check(
    'ALLOW_DEV_OTP echoes the code',
    typeof echoed.json?.devCode === 'string' && /^\d{6}$/.test(echoed.json.devCode),
    JSON.stringify(echoed.json),
  );

  appEnv.isProduction = false;
  appEnv.allowDevOtp = false;

  const unknownLogin = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'ghost@example.com', isLogin: true },
  });
  check(
    'login with unknown email is 404',
    unknownLogin.status === 404 && unknownLogin.json?.error?.code === 'ACCOUNT_NOT_FOUND',
    JSON.stringify(unknownLogin.json),
  );

  const badEmail = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'not-an-email', isLogin: false },
  });
  check(
    'invalid email is rejected with 400',
    badEmail.status === 400 && badEmail.json?.error?.code === 'VALIDATION_ERROR',
    JSON.stringify(badEmail.json),
  );

  lastOtp = null;
  const send = await call('/api/auth/send-otp', {
    method: 'POST',
    body: {
      method: 'email',
      identifier: 'New.User@Example.com',
      isLogin: false,
      name: 'New User',
    },
  });
  check('send-otp returns 202', send.status === 202, `status ${send.status}`);
  check('send-otp returns an expiry', send.json?.expiresIn === 300, JSON.stringify(send.json));
  check('OTP was generated', Boolean(lastOtp), 'no OTP captured from the transport log');
  check(
    'undelivered OTP is returned as a development code',
    /^\d{6}$/.test(send.json?.devCode ?? ''),
    JSON.stringify(send.json),
  );

  const wrongOtp = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'new.user@example.com', otp: '000000' },
  });
  const otpInvalid =
    wrongOtp.status === 400 &&
    (wrongOtp.json?.error?.code === 'OTP_INVALID' || wrongOtp.json?.error?.code === 'OTP_EXPIRED');
  check('wrong OTP is rejected', otpInvalid, JSON.stringify(wrongOtp.json));

  const verify = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'NEW.USER@example.com', otp: lastOtp },
  });
  check('verify-otp returns 200', verify.status === 200, `status ${verify.status}`);
  check('verify-otp returns an access token', Boolean(verify.json?.accessToken));
  check(
    'user is created with a verified email',
    verify.json?.user?.email === 'new.user@example.com' && verify.json?.user?.emailVerified === true,
    JSON.stringify(verify.json?.user),
  );
  check(
    'refresh token cookie is httpOnly',
    verify.setCookie.some((entry) => entry.startsWith('refresh_token=') && /HttpOnly/i.test(entry)),
    verify.setCookie.join(' | '),
  );

  const consumedRecord = await Otp.findOne({ method: 'email', identifier: 'new.user@example.com' });
  check(
    'consumed OTP is marked as used',
    consumedRecord?.consumedAt instanceof Date,
    String(consumedRecord?.consumedAt),
  );

  const replayConsumed = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'new.user@example.com', otp: lastOtp },
  });
  check(
    'replaying a consumed OTP fails',
    replayConsumed.status === 400 && replayConsumed.json?.error?.code === 'OTP_ALREADY_USED',
    JSON.stringify(replayConsumed.json),
  );

  const refreshCookie = cookieHeader(verify.setCookie);
  const me = await call('/api/auth/me', { token: verify.json.accessToken });
  check('GET /me works with a bearer token', me.status === 200 && me.json?.user?.emailVerified, JSON.stringify(me.json));
  const meWithCookie = await call('/api/auth/me', {
    cookie: cookieHeader(verify.setCookie.filter((entry) => entry.startsWith('access_token='))),
  });
  check('GET /me works with the access cookie', meWithCookie.status === 200, `status ${meWithCookie.status}`);

  const sessions = await call('/api/auth/sessions', {
    token: verify.json.accessToken,
    cookie: refreshCookie,
  });
  const listed = sessions.json?.sessions ?? [];
  check(
    'sessions endpoint lists the current session',
    sessions.status === 200 && listed.length === 1 && listed[0].current === true,
    JSON.stringify(sessions.json),
  );
  check(
    'session metadata is recorded',
    Boolean(listed[0]?.userAgent) && Boolean(listed[0]?.ip),
    JSON.stringify(listed[0]),
  );

  const duplicate = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'new.user@example.com', isLogin: false },
  });
  check(
    'duplicate registration is 409',
    duplicate.status === 409 && duplicate.json?.error?.code === 'ACCOUNT_EXISTS',
    JSON.stringify(duplicate.json),
  );

  const loginAgain = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'new.user@example.com', isLogin: true },
  });
  check('existing user can request a login code', loginAgain.status === 202, JSON.stringify(loginAgain.json));

  const refresh = await call('/api/auth/refresh', { method: 'POST', cookie: refreshCookie });
  check('refresh rotates the session', refresh.status === 200 && Boolean(refresh.json?.accessToken), JSON.stringify(refresh.json));

  const reuse = await call('/api/auth/refresh', { method: 'POST', cookie: refreshCookie });
  check(
    'reusing a rotated refresh token is 401',
    reuse.status === 401 && reuse.json?.error?.code === 'REFRESH_TOKEN_REUSED',
    JSON.stringify(reuse.json),
  );

  const afterReuse = await call('/api/auth/refresh', {
    method: 'POST',
    cookie: cookieHeader(refresh.setCookie),
  });
  check('reuse revokes the whole family', afterReuse.status === 401, `status ${afterReuse.status}`);

  const logout = await call('/api/auth/logout', { method: 'POST', cookie: cookieHeader(refresh.setCookie) });
  check('logout returns 200', logout.status === 200, `status ${logout.status}`);

  // Phone flow
  lastOtp = null;
  const phoneSend = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '9876543210', isLogin: false, name: 'Phone User' },
  });
  check('phone send-otp returns 202', phoneSend.status === 202, JSON.stringify(phoneSend.json));
  const phoneVerify = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '9876543210', otp: lastOtp },
  });
  check(
    'phone verify creates a verified account',
    phoneVerify.status === 200 && phoneVerify.json?.user?.phone === '9876543210',
    JSON.stringify(phoneVerify.json),
  );
  check('phone user is marked verified', phoneVerify.json?.user?.phoneVerified === true);

  const phoneDuplicate = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '9876543210', isLogin: false },
  });
  check(
    'duplicate phone registration is 409',
    phoneDuplicate.status === 409,
    JSON.stringify(phoneDuplicate.json),
  );

  const badPhone = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '12345', isLogin: false },
  });
  check('short phone number is rejected', badPhone.status === 400, JSON.stringify(badPhone.json));

  // OAuth guards
  const googleInvalid = await call('/api/auth/google', {
    method: 'POST',
    body: { token: 'not-a-real-access-token' },
  });
  check(
    'google rejects an unknown token',
    googleInvalid.status === 401 && googleInvalid.json?.error?.code === 'INVALID_GOOGLE_TOKEN',
    JSON.stringify(googleInvalid.json),
  );

  const googleWrongAudience = await call('/api/auth/google', {
    method: 'POST',
    body: { token: GOOGLE_WRONG_AUDIENCE_TOKEN },
  });
  check(
    'google rejects a token issued for another app',
    googleWrongAudience.status === 401 &&
      googleWrongAudience.json?.error?.code === 'GOOGLE_TOKEN_AUDIENCE_MISMATCH',
    JSON.stringify(googleWrongAudience.json),
  );

  const googleSignIn = await call('/api/auth/google', {
    method: 'POST',
    body: { token: GOOGLE_VALID_TOKEN },
  });
  check(
    'google sign-in creates a session',
    googleSignIn.status === 200 && Boolean(googleSignIn.json?.accessToken),
    JSON.stringify(googleSignIn.json),
  );
  check(
    'google profile is stored',
    googleSignIn.json?.user?.email === 'google.user@example.com' &&
      googleSignIn.json?.user?.name === 'Google User' &&
      googleSignIn.json?.user?.providers?.google === true,
    JSON.stringify(googleSignIn.json?.user),
  );

  const googleAgain = await call('/api/auth/google', {
    method: 'POST',
    body: { token: GOOGLE_VALID_TOKEN },
  });
  check(
    'google repeat sign-in reuses the account',
    googleAgain.status === 200 && googleAgain.json?.user?.id === googleSignIn.json?.user?.id,
    JSON.stringify(googleAgain.json),
  );

  const apple = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: 'invalid.apple.identity.token' },
  });
  check(
    'apple rejects a malformed identity token',
    apple.status === 401 && apple.json?.error?.code === 'INVALID_APPLE_TOKEN',
    JSON.stringify(apple.json),
  );

  const wrongAudience = await appleIdentityToken({
    sub: 'apple-user-000',
    email: 'other.app@example.com',
    audience: 'com.some.other.app',
  });
  const wrongAudienceResponse = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: wrongAudience },
  });
  check(
    'apple rejects a token issued for another app',
    wrongAudienceResponse.status === 401 &&
      wrongAudienceResponse.json?.error?.code === 'INVALID_APPLE_TOKEN',
    JSON.stringify(wrongAudienceResponse.json),
  );

  const wrongIssuer = await appleIdentityToken({
    sub: 'apple-user-000',
    email: 'other.issuer@example.com',
    issuer: 'https://evil.example.com',
  });
  const wrongIssuerResponse = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: wrongIssuer },
  });
  check(
    'apple rejects a token from another issuer',
    wrongIssuerResponse.status === 401 &&
      wrongIssuerResponse.json?.error?.code === 'INVALID_APPLE_TOKEN',
    JSON.stringify(wrongIssuerResponse.json),
  );

  const expiredAppleToken = await appleIdentityToken({
    sub: 'apple-user-000',
    email: 'expired@example.com',
    expiresAt: Math.floor(Date.now() / 1000) - 60,
  });
  const expiredAppleResponse = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: expiredAppleToken },
  });
  check(
    'apple rejects an expired identity token',
    expiredAppleResponse.status === 401 &&
      expiredAppleResponse.json?.error?.code === 'INVALID_APPLE_TOKEN',
    JSON.stringify(expiredAppleResponse.json),
  );

  const shortAppleToken = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: 'short' },
  });
  check(
    'apple rejects a token that is too short to be a JWT',
    shortAppleToken.status === 400 && shortAppleToken.json?.error?.code === 'VALIDATION_ERROR',
    JSON.stringify(shortAppleToken.json),
  );

  const firstAppleToken = await appleIdentityToken({
    sub: 'apple-user-001',
    email: 'Apple.User@Example.com',
  });
  const appleSignIn = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: firstAppleToken, name: { firstName: 'Ada', lastName: 'Lovelace' } },
  });
  check(
    'apple sign-in creates a session',
    appleSignIn.status === 200 && Boolean(appleSignIn.json?.accessToken),
    JSON.stringify(appleSignIn.json),
  );
  check(
    'apple stores the name from the first authorisation',
    appleSignIn.json?.user?.name === 'Ada Lovelace',
    JSON.stringify(appleSignIn.json?.user),
  );
  check(
    'apple stores a verified, lowercased email',
    appleSignIn.json?.user?.email === 'apple.user@example.com' &&
      appleSignIn.json?.user?.emailVerified === true,
    JSON.stringify(appleSignIn.json?.user),
  );
  check(
    'apple provider is linked',
    appleSignIn.json?.user?.providers?.apple === true,
    JSON.stringify(appleSignIn.json?.user?.providers),
  );

  // Apple only shares the name on the first authorisation; later ones send no
  // email either when the user hides it.
  const repeatAppleToken = await appleIdentityToken({ sub: 'apple-user-001' });
  const repeatApple = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: repeatAppleToken },
  });
  check(
    'apple repeat sign-in reuses the same account',
    repeatApple.status === 200 && repeatApple.json?.user?.id === appleSignIn.json?.user?.id,
    JSON.stringify(repeatApple.json),
  );
  check(
    'apple repeat sign-in keeps the stored email and name',
    repeatApple.json?.user?.email === 'apple.user@example.com' &&
      repeatApple.json?.user?.name === 'Ada Lovelace',
    JSON.stringify(repeatApple.json?.user),
  );

  lastOtp = null;
  await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'linked@example.com', isLogin: false, name: 'Link Me' },
  });
  const linkedEmailSession = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'linked@example.com', otp: lastOtp },
  });
  const linkedAppleToken = await appleIdentityToken({
    sub: 'apple-user-002',
    email: 'linked@example.com',
  });
  const linkedApple = await call('/api/auth/apple', {
    method: 'POST',
    body: { identityToken: linkedAppleToken },
  });
  check(
    'apple links to an existing email account',
    linkedApple.status === 200 &&
      linkedApple.json?.user?.id === linkedEmailSession.json?.user?.id &&
      linkedApple.json?.user?.providers?.apple === true,
    JSON.stringify(linkedApple.json),
  );

  const badRoute = await call('/api/auth/nope');
  check('unknown route is 404', badRoute.status === 404, `status ${badRoute.status}`);

  // OTP attempt lockout
  lastOtp = null;
  await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'lockout@example.com', isLogin: false, name: 'Lock Out' },
  });
  const wrongCode = lastOtp === '000000' ? '111111' : '000000';
  let lastAttempt;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastAttempt = await call('/api/auth/verify-otp', {
      method: 'POST',
      body: { method: 'email', identifier: 'lockout@example.com', otp: wrongCode },
    });
  }
  check(
    'five wrong attempts are rejected as OTP_INVALID',
    lastAttempt.status === 400 && lastAttempt.json?.error?.code === 'OTP_INVALID',
    JSON.stringify(lastAttempt.json),
  );

  const lockedOut = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'lockout@example.com', otp: lastOtp },
  });
  check(
    'correct code is blocked after the attempt limit',
    lockedOut.status === 429 && lockedOut.json?.error?.code === 'RATE_LIMITED',
    JSON.stringify(lockedOut.json),
  );

  // Logout everywhere
  lastOtp = null;
  await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'logout.all@example.com', isLogin: false, name: 'Logout All' },
  });
  const allSession = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'logout.all@example.com', otp: lastOtp },
  });
  const allCookie = cookieHeader(allSession.setCookie);
  const logoutAll = await call('/api/auth/logout-all', {
    method: 'POST',
    token: allSession.json.accessToken,
    cookie: allCookie,
  });
  check(
    'logout-all revokes sessions',
    logoutAll.status === 200 && logoutAll.json?.revoked >= 1,
    JSON.stringify(logoutAll.json),
  );
  const afterLogoutAll = await call('/api/auth/refresh', { method: 'POST', cookie: allCookie });
  check(
    'logout-all invalidates the refresh token',
    afterLogoutAll.status === 401,
    `status ${afterLogoutAll.status}`,
  );

  // Email delivery through a real SMTP conversation
  const { env } = await import('../src/config/env.js');
  const sink = await startSmtpSink();
  const previousSmtp = { ...env.smtp };

  Object.assign(env.smtp, {
    host: '127.0.0.1',
    port: sink.port,
    secure: false,
    user: '',
    pass: '',
    service: '',
    from: 'Taskwork <no-reply@taskwork.local>',
  });

  const emailSend = await call('/api/auth/send-otp', {
    method: 'POST',
    body: {
      method: 'email',
      identifier: 'smtp.delivery@example.com',
      isLogin: false,
      name: 'SMTP Delivery',
    },
  });
  check('smtp send-otp returns 202', emailSend.status === 202, JSON.stringify(emailSend.json));
  check(
    'a delivered OTP is not echoed back as devCode',
    emailSend.json?.devCode === undefined,
    JSON.stringify(emailSend.json),
  );

  const delivered = await waitFor(() =>
    sink.messages.length ? sink.messages.join('\n') : null,
  );
  check('the email reached the SMTP server', Boolean(delivered), 'no message received');

  const emailedCode =
    delivered?.match(/verification code is (\d{6})/i)?.[1] ?? delivered?.match(/(\d{6})/)?.[1];
  check(
    'the email carries the OTP code',
    Boolean(emailedCode),
    `${emailedCode} <- ${delivered?.slice(0, 200)}`,
  );

  const gmailVerify = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'email', identifier: 'smtp.delivery@example.com', otp: emailedCode },
  });
  check(
    'the emailed code signs the user in',
    gmailVerify.status === 200 && gmailVerify.json?.user?.email === 'smtp.delivery@example.com',
    JSON.stringify(gmailVerify.json),
  );

  await new Promise((resolve) => sink.server.close(resolve));
  Object.assign(env.smtp, previousSmtp);

  // A broken transport must fail loudly and not leave a live OTP behind.
  Object.assign(env.smtp, { host: '127.0.0.1', port: 1, secure: false, user: '', pass: '', service: '' });

  const undeliverable = await call('/api/auth/send-otp', {
    method: 'POST',
    body: {
      method: 'email',
      identifier: 'smtp.down@example.com',
      isLogin: false,
      name: 'SMTP Down',
    },
  });
  check(
    'an undeliverable OTP is 502 EMAIL_DELIVERY_FAILED',
    undeliverable.status === 502 && undeliverable.json?.error?.code === 'EMAIL_DELIVERY_FAILED',
    JSON.stringify(undeliverable.json),
  );

  const orphaned = await Otp.findOne({ method: 'email', identifier: 'smtp.down@example.com' });
  check('a failed delivery leaves no live OTP', orphaned === null, String(orphaned));

  Object.assign(env.smtp, previousSmtp);

  // SMS delivery through a stubbed Twilio API
  const smsRequests = [];
  const smsSink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      smsRequests.push({ url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/fail')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"message":"invalid"}');
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"sid":"SM0000","status":"queued"}');
    });
  });
  await new Promise((resolve) => smsSink.listen(0, '127.0.0.1', resolve));

  const previousSms = { ...env.sms };
  const previousTwilio = { ...env.twilio };
  const accountSid = 'AC00000000000000000000000000000000';
  const authToken = 'test-auth-token';

  Object.assign(env.sms, { provider: 'twilio' });
  Object.assign(env.twilio, {
    accountSid,
    authToken,
    from: '+15005550006',
    apiBase: `http://127.0.0.1:${smsSink.address().port}/2010-04-01/Accounts`,
  });

  const smsSend = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '9000000001', isLogin: false, name: 'SMS User' },
  });
  check('twilio send-otp returns 202', smsSend.status === 202, JSON.stringify(smsSend.json));
  check(
    'a delivered SMS is not echoed back as devCode',
    smsSend.json?.devCode === undefined,
    JSON.stringify(smsSend.json),
  );

  const smsRequest = await waitFor(() => smsRequests[0] ?? null);
  check('the SMS request reached the provider', Boolean(smsRequest), 'no request received');

  const smsParams = new URLSearchParams(smsRequest?.body ?? '');
  const smsBody = smsParams.get('Body') ?? '';
  const smsCode = smsBody.match(/code is (\d{6})/)?.[1];

  check(
    'the SMS goes to the E.164 number',
    smsParams.get('To') === '+919000000001',
    smsRequest?.body,
  );
  check(
    'the provider is called with basic auth',
    smsRequest?.headers?.authorization ===
      `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    smsRequest?.headers?.authorization,
  );
  check('the SMS carries the OTP code', Boolean(smsCode), smsBody.slice(0, 120));

  const smsVerify = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '9000000001', otp: smsCode },
  });
  check(
    'the texted code signs the user in',
    smsVerify.status === 200 && smsVerify.json?.user?.phone === '9000000001',
    JSON.stringify(smsVerify.json),
  );

  Object.assign(env.twilio, { apiBase: `http://127.0.0.1:${smsSink.address().port}/fail` });
  const smsFailure = await call('/api/auth/send-otp', {
    method: 'POST',
    body: { method: 'phone', identifier: '9000000002', isLogin: false, name: 'SMS Down' },
  });
  check(
    'a rejected SMS is 502 SMS_DELIVERY_FAILED',
    smsFailure.status === 502 && smsFailure.json?.error?.code === 'SMS_DELIVERY_FAILED',
    JSON.stringify(smsFailure.json),
  );

  const smsOrphan = await Otp.findOne({ method: 'phone', identifier: '9000000002' });
  check('a failed SMS leaves no live OTP', smsOrphan === null, String(smsOrphan));

  Object.assign(env.sms, previousSms);
  Object.assign(env.twilio, previousTwilio);
  await new Promise((resolve) => smsSink.close(resolve));

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await disconnectDb();
  await new Promise((resolve) => server.close(resolve));
  await mongod.stop();
  await new Promise((resolve) => jwksServer.close(resolve));
  await new Promise((resolve) => googleSink.close(resolve));
}