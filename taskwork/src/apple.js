const APPLE_SDK_ID = 'appleid-signin-sdk';
const APPLE_SDK_SRC =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

let sdkPromise = null;

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

  const name = response?.user?.name;
  const fullName = name
    ? [name.firstName, name.middleName, name.lastName].filter(Boolean).join(' ')
    : '';

  return { identityToken, name: fullName || undefined };
}

export function appleErrorMessage(error) {
  const code = typeof error === 'string' ? error : error?.error;

  switch (code) {
    case 'popup_closed_by_user':
    case 'user_cancelled_authorize':
    case 'user_cancelled_login':
      return 'Apple sign-in was cancelled.';
    case 'popup_blocked':
      return 'The Apple sign-in popup was blocked. Allow popups and try again.';
    default:
      return 'Apple sign-in failed, please try again.';
  }
}