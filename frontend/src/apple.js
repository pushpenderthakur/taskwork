/**
 * Apple sign-in (web).
 *
 * Loads Apple's JS SDK on demand and runs a popup authorisation. The SDK posts
 * the identity token back to the opener, which is forwarded to `POST /auth/apple`;
 * the server verifies it against Apple's JWKS.
 */
const APPLE_SDK_ID = 'appleid-signin-sdk';
const APPLE_SDK_SRC =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

// Cached promise so the script is injected at most once.
let sdkPromise = null;

/** Injects the SDK script once and resolves with `window.AppleID`. */
function loadAppleSdk() {
  if (window.AppleID?.auth) return Promise.resolve(window.AppleID);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = APPLE_SDK_ID;
    script.src = APPLE_SDK_SRC;
    script.async = true;
    script.onload = () =>
      window.AppleID?.auth
        ? resolve(window.AppleID)
        : reject(new Error('Apple Sign In did not initialise.'));
    script.onerror = () => {
      // Allow a retry after a network failure.
      sdkPromise = null;
      reject(new Error('Could not load Apple Sign In. Check your connection.'));
    };
    document.head.appendChild(script);
  });

  return sdkPromise;
}

/**
 * Runs one Apple authorisation in a popup and returns the identity token plus
 * the name Apple shares on the first authorisation only.
 *
 * `redirectURI` must match a Return URL registered on the Services ID and is
 * served over HTTPS — Apple rejects localhost origins.
 */
export async function signInWithApple({ clientId }) {
  const apple = await loadAppleSdk();

  apple.auth.init({
    clientId,
    scope: 'name email',
    redirectURI: `${window.location.origin}${window.location.pathname}`,
    usePopup: true,
  });

  const response = await apple.auth.signIn();
  const identityToken = response?.authorization?.id_token;

  if (!identityToken) {
    throw new Error('Apple did not return an identity token.');
  }

  // Apple sends `{ firstName, middleName, lastName }`, and only on the first login.
  const name = response?.user?.name;
  const fullName = name
    ? [name.firstName, name.middleName, name.lastName].filter(Boolean).join(' ')
    : '';

  return { identityToken, name: fullName || undefined };
}

/** Maps Apple SDK errors (cancel, blocked popup, bad config) to user text. */
export function appleErrorMessage(error) {
  const code = typeof error === 'string' ? error : (error?.error ?? error?.code);

  switch (code) {
    case 'popup_closed_by_user':
    case 'user_cancelled_authorize':
    case 'user_cancelled_login':
      return 'Apple sign-in was cancelled.';
    case 'popup_blocked':
      return 'The Apple sign-in popup was blocked. Allow popups and try again.';
    case 'not_supported':
      return 'This browser cannot open Apple sign-in. Try another browser.';
    case 'invalid_client':
      // Apple rejects the client ID when it is not the Services ID, or when the
      // current origin is not a Return URL on that Services ID.
      return 'Apple rejected this client ID. Check VITE_APPLE_CLIENT_ID and that this origin is a Return URL on the Services ID.';
    default:
      // The raw code is the only lead when the SDK reports something unexpected.
      return `Apple sign-in failed${code ? ` (${code})` : ''}, please try again.`;
  }
}