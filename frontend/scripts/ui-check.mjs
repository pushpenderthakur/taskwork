#!/usr/bin/env node
/**
 * UI check for the Taskwork SPA.
 *
 * Drives the real app in headless Chrome over the DevTools protocol: fills the
 * form, submits it, reads the development OTP from the UI and completes
 * verification. Requires the API and the SPA dev server to be running.
 *
 * Run with: npm run test:ui
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.UI_BASE_URL ?? 'http://localhost:5173';
const API_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:5000/api/auth';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitFor(fn, { timeout = 15_000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` -> ${detail}` : ''}`);
}

let chrome;
let userDataDir;

try {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('No Chrome/Edge binary found. Set CHROME_PATH to the executable.');
    process.exit(1);
  }

  const spaReachable = await waitFor(
    () => fetch(BASE_URL).then((response) => response.ok).catch(() => false),
    { timeout: 5000 },
  );
  if (!spaReachable) {
    console.error(`${BASE_URL} is not reachable. Start the SPA with \`npm run dev\`.`);
    process.exit(1);
  }

  const servedConfig = await fetch(`${BASE_URL}/src/config.js`)
    .then((response) => response.text())
    .catch(() => '');
  check(
    'the SPA is pointed at the API',
    servedConfig.includes(API_URL),
    `${API_URL} not found in the served config`,
  );

  const apiHealthUrl = `${new URL(API_URL).origin}/api/health`;
  const apiReachable = await fetch(apiHealthUrl)
    .then((response) => response.ok)
    .catch(() => false);
  if (!apiReachable) {
    console.error(`The API is not reachable at ${apiHealthUrl}. Start it with \`npm run dev:server\`.`);
    process.exit(1);
  }

  userDataDir = mkdtempSync(join(tmpdir(), 'taskwork-ui-'));
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const version = await waitFor(() =>
    fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      .then((response) => response.json())
      .catch(() => null),
  );
  if (!version) throw new Error('Chrome did not expose the DevTools endpoint');

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('No page target available');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let messageId = 0;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve));

  function send(method, params = {}) {
    const id = ++messageId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result.value;
  }

  const setInput = (selector, value) => `(() => {
    const el = document.querySelector('${selector}');
    if (!el) return 'missing:${selector}';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`;

  const clickSubmit = `(() => {
    const button = document.querySelector('form button[type="submit"]');
    if (!button) return false;
    button.click();
    return true;
  })()`;

  const devCodeFrom = (text) => text.match(/Development code[^:]*:\s*(\d{6})/i)?.[1] ?? null;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `${BASE_URL}/` });
  await sleep(2500);
  await evaluate('localStorage.clear()');
  await send('Page.reload');
  await sleep(3000);

  check('form rendered', await evaluate(`document.body.innerText.includes('Welcome Back')`));

  await evaluate(clickSubmit);
  await sleep(400);
  check(
    'empty email is rejected client side',
    await evaluate(`document.body.innerText.includes('Invalid email')`),
    await evaluate(`document.body.innerText.slice(0, 200)`),
  );

  const email = `ui.check.${Date.now()}@example.com`;
  await evaluate(setInput('input[name="email"]', email));
  await evaluate(clickSubmit);
  await sleep(2500);

  const afterFirstSubmit = await evaluate(`document.body.innerText`);
  check(
    'unknown account offers to register instead',
    afterFirstSubmit.includes('No account with this email') ||
      afterFirstSubmit.includes('Create an Account'),
    afterFirstSubmit.slice(0, 200),
  );

  await evaluate(setInput('input[name="name"]', 'UI Tester'));
  await evaluate(clickSubmit);
  await sleep(2500);

  const stepTwo = await evaluate(`document.body.innerText`);
  check(
    'advanced to the OTP step',
    stepTwo.toLowerCase().includes('enter 6-digit otp'),
    stepTwo.slice(0, 200),
  );

  const code = devCodeFrom(stepTwo);
  check('development OTP is shown in the UI', Boolean(code), stepTwo.slice(0, 300));

  // The resend button must start in its cooldown state instead of firing a 429.
  const resendState = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.includes('Resend code'),
    );
    return button ? { label: button.textContent.trim(), disabled: button.disabled } : null;
  })()`);
  check(
    'resend shows the server cooldown',
    Boolean(resendState) && resendState.disabled && /Resend code in \d+s/.test(resendState.label ?? ''),
    JSON.stringify(resendState),
  );

  await evaluate(setInput('input[name="otp"]', code));
  await sleep(200);
  await evaluate(clickSubmit);
  await sleep(2500);

  const done = await evaluate(`document.body.innerText`);
  check(
    'dashboard renders after sign in',
    done.toLowerCase().includes('active sessions'),
    done.slice(0, 300),
  );

  const stored = await evaluate(`JSON.stringify({
    token: Boolean(localStorage.getItem('taskwork.token')),
    user: localStorage.getItem('taskwork.user'),
  })`);
  const session = JSON.parse(stored);
  check('session stored in the browser', session.token && Boolean(session.user), stored);
  check('verified user persisted', JSON.parse(session.user).email === email, stored);

  const signOutClicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Sign out'
    );
    button?.click();
    return Boolean(button);
  })()`);
  check('sign out returns to the auth form', signOutClicked);
  await sleep(2500);
  const afterSignOut = await evaluate(`document.body.innerText`);
  check(
    'signed out user sees the auth form',
    afterSignOut.includes('Welcome Back'),
    afterSignOut.slice(0, 200),
  );

  const switched = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Phone OTP')
    );
    button?.click();
    return Boolean(button);
  })()`);
  check('phone tab is selectable', switched);
  await sleep(400);

  await evaluate(setInput('input[name="phone"]', '9812345678'));
  await evaluate(clickSubmit);
  await sleep(2500);

  let phoneStep = await evaluate(`document.body.innerText`);
  let phoneCode = devCodeFrom(phoneStep);

  // Unknown number: the form flips to register, so submit once more.
  if (!phoneCode) {
    await evaluate(clickSubmit);
    await sleep(2500);
    phoneStep = await evaluate(`document.body.innerText`);
    phoneCode = devCodeFrom(phoneStep);
  }
  check('phone tab sends an OTP', Boolean(phoneCode), phoneStep.slice(0, 200));

  await evaluate(setInput('input[name="otp"]', phoneCode));
  await sleep(200);
  await evaluate(clickSubmit);
  await sleep(2500);

  const phoneDone = await evaluate(`document.body.innerText`);
  check(
    'phone sign-in succeeds',
    phoneDone.toLowerCase().includes('active sessions') && phoneDone.includes('9812345678'),
    phoneDone.slice(0, 200),
  );

  ws.close();
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('UI check crashed:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  if (chrome && !chrome.killed) chrome.kill();
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}