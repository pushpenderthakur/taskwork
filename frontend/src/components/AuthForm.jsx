/**
 * Sign-in / sign-up form.
 *
 * Two steps: collect an email or phone (step 1, `send-otp`), then verify the
 * 6-digit code (step 2, `verify-otp`). Social buttons sit outside the form and
 * call the OAuth routes directly. When `VITE_API_BASE_URL` is empty the form
 * runs in mock mode, which keeps the UI usable without a backend.
 */
import { useEffect, useState } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { Mail, Phone, ShieldCheck, ArrowRight, Loader2 } from 'lucide-react';
import { api, apiErrorMessage, saveSession } from '../api';
import { APPLE_CLIENT_ID, API_URL, isAppleConfigured, isGoogleConfigured } from '../config';
import { appleErrorMessage, signInWithApple } from '../apple';

const SOCIAL_BUTTON_CLASS =
  'flex items-center justify-center gap-2 py-2.5 px-4 border border-slate-300 rounded-lg hover:bg-slate-50 transition text-sm font-medium text-slate-700';

/** Maps Google Identity Services error codes to actionable text. */
function googleErrorMessage(reason) {
  switch (reason) {
    case 'popup_closed_by_user':
      return 'Google sign-in was cancelled.';
    case 'popup_failed_to_open':
    case 'popup_blocked':
      return 'The Google popup was blocked. Allow popups for this site and try again.';
    case 'token_initialization_failed':
    case 'oauth_initialization_failed':
      return 'Google sign-in is not allowed for this origin. Add it to the OAuth client’s authorized JavaScript origins.';
    case 'idpiframe_initialization_failed':
    case 'idpiframe_load_failed':
      // Chrome's storage partitioning is the usual cause: GIS needs to read
      // third-party cookies from accounts.google.com to size its iframe.
      return 'Google sign-in needs third-party cookies. Allow them for accounts.google.com (or use a browser without strict tracking protection) and try again.';
    case 'invalid_client':
      return 'Google rejected the client ID. Check VITE_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_ID match.';
    default:
      // The raw code is the only lead when GIS reports something unexpected.
      return `Google sign-in failed${reason ? ` (${reason})` : ''}, please try again.`;
  }
}

// Rendered only when a Google client ID is configured, so the OAuth context exists.
function GoogleButton({ onLogin }) {
  const login = useGoogleLogin({
    onSuccess: (tokenResponse) => onLogin(tokenResponse),
    // GIS reports why it failed; the parent turns the code into a message.
    onError: (error) => onLogin({ error: error?.type ?? error?.error ?? 'unknown' }),
  });

  return (
    <button type="button" onClick={() => login()} className={SOCIAL_BUTTON_CLASS}>
      <img
        src="https://www.svgrepo.com/show/475656/google-color.svg"
        alt=""
        className="w-5 h-5"
      />
      Google
    </button>
  );
}

export default function AuthForm({ onAuthenticated }) {
  // Which of the two forms is shown, and which channel it targets.
  const [isLogin, setIsLogin] = useState(true); // Login vs Register toggle
  const [authMethod, setAuthMethod] = useState('email'); // 'email' | 'phone'
  const [step, setStep] = useState(1); // 1: Input Details, 2: Enter OTP
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  // Timestamp until which the server rejects a resend (30s by default).
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    otp: ''
  });

  // Strips non-digits for phone/OTP fields so the stored value stays clean.
  const handleChange = (e) => {
    const { name, value } = e.target;
    const nextValue = name === 'phone' || name === 'otp' ? value.replace(/\D/g, '') : value;
    setFormData((prev) => ({ ...prev, [name]: nextValue }));
    setError('');
  };

  // Client-side checks; the server validates again with zod.
  const validateInput = () => {
    if (!isLogin && !formData.name.trim()) {
      setError('Please enter your full name (Name is required).');
      return false;
    }
    if (authMethod === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.email)) {
        setError('Please enter a valid email address (Invalid email address).');
        return false;
      }
    } else {
      const phoneRegex = /^[0-9]{10}$/;
      if (!phoneRegex.test(formData.phone)) {
        setError('Please enter a valid 10-digit mobile number (10-digit phone number required).');
        return false;
      }
    }
    return true;
  };

  // Ticks once a second while a resend cooldown is running.
  useEffect(() => {
    if (!resendAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);

  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));

  // Shared by the first send and the resend button.
  const requestOtp = async () => {
    const payload = {
      method: authMethod,
      identifier: authMethod === 'email' ? formData.email : formData.phone,
      isLogin,
      ...(isLogin ? {} : { name: formData.name }),
    };

    if (API_URL) {
      const { data } = await api.post('/send-otp', payload);
      const destination =
        data.destination ?? (authMethod === 'email' ? 'your email' : 'your mobile number');
      setInfoMsg('');
      setSuccessMsg(
        data.devCode
          ? `Development code for ${destination}: ${data.devCode} (no ${
              authMethod === 'email' ? 'email' : 'SMS'
            } provider is configured).`
          : `OTP sent to ${destination}.`,
      );
      // Mirror the server's resend cooldown so the button cannot trigger a 429.
      setResendAt(Date.now() + (data.resendAfter ?? 30) * 1000);
      setStep(2);
      return;
    }

    // Mock mode: no backend configured, so simulate the round trip.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setStep(2);
    setSuccessMsg(
      `OTP sent to your ${authMethod === 'email' ? 'email' : 'mobile number'}.`,
    );
  };

  // Step 1: Send OTP Handler
  const handleSendOtp = async (e) => {
    e.preventDefault();
    if (!validateInput()) return;

    setLoading(true);
    setError('');
    try {
      await requestOtp();
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      const field = authMethod === 'email' ? 'email' : 'phone number';

      // Self-correcting UX: flip the toggle instead of dead-ending the user.
      if (code === 'ACCOUNT_NOT_FOUND') {
        setIsLogin(false);
        setError('');
        setInfoMsg(`No account with this ${field} yet — add your name and register.`);
        return;
      }
      if (code === 'ACCOUNT_EXISTS') {
        setIsLogin(true);
        setError('');
        setInfoMsg(`This ${field} is already registered — sign in instead.`);
        return;
      }

      setError(apiErrorMessage(err, 'Could not send OTP, please try again.'));
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Resend the code for the same destination.
  const handleResend = async () => {
    if (Date.now() < resendAt) return;

    setLoading(true);
    setError('');
    try {
      await requestOtp();
      // The previous code is dead once a new one is issued.
      setFormData((prev) => ({ ...prev, otp: '' }));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not resend the code, please try again.'));
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify OTP Handler
  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (formData.otp.length !== 6) {
      setError('Please enter a valid 6-digit OTP.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      if (API_URL) {
        const identifier =
          authMethod === 'email' ? formData.email : formData.phone;
        const { data } = await api.post('/verify-otp', {
          method: authMethod,
          identifier,
          otp: formData.otp,
          name: formData.name,
        });
        saveSession(data);
        onAuthenticated?.(data.user);
        return;
      } else {
        // No backend configured, so simulate a delay for UI testing
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      setSuccessMsg('Logged in successfully! (Authentication Successful)');
    } catch (err) {
      setError(apiErrorMessage(err, 'Invalid OTP.'));
    } finally {
      setLoading(false);
    }
  };

  // Google OAuth (real flow when VITE_GOOGLE_CLIENT_ID is set).
  // A `tokenResponse` with an `error` field means the popup never completed.
  const handleGoogleLogin = async (tokenResponse) => {
    setError('');
    setInfoMsg('');

    if (!tokenResponse) {
      setError('Google login was cancelled, please try again.');
      return;
    }

    if (tokenResponse.error) {
      setError(googleErrorMessage(tokenResponse.error));
      return;
    }

    const accessToken = tokenResponse.access_token;
    if (!accessToken) {
      setError('Google did not return an access token. Check the OAuth client configuration.');
      return;
    }

    setLoading(true);
    try {
      if (API_URL) {
        const { data } = await api.post('/google', { token: accessToken });
        saveSession(data);
        onAuthenticated?.(data.user);
        return;
      }
      setSuccessMsg('Google login successful!');
    } catch (err) {
      setError(apiErrorMessage(err, 'Google login failed, please try again.'));
    } finally {
      setLoading(false);
    }
  };

  /** Shown when Google is not configured, instead of loading the SDK. */
  const handleGoogleUnavailable = () => {
    setError('');
    setInfoMsg('Set VITE_GOOGLE_CLIENT_ID in .env to enable Google login.');
  };

  // Apple popup sign-in; Apple shares the name only on the first authorisation.
  const handleAppleLogin = async () => {
    setError('');
    setInfoMsg('');

    if (!isAppleConfigured) {
      setInfoMsg('Set VITE_APPLE_CLIENT_ID in .env to enable Apple login.');
      return;
    }

    setLoading(true);
    try {
      const { identityToken, name } = await signInWithApple({ clientId: APPLE_CLIENT_ID });

      if (API_URL) {
        const { data } = await api.post('/apple', { identityToken, name });
        saveSession(data);
        onAuthenticated?.(data.user);
        return;
      }
      setSuccessMsg('Apple login successful!');
    } catch (err) {
      setError(apiErrorMessage(err, appleErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
        
        {/* Header */}
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-slate-800">
            {isLogin ? 'Welcome Back' : 'Create an Account'}
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            {isLogin ? 'Log in to your account' : 'Enter your details to create a new account'}
          </p>
        </div>

        {/* Error & Success Alerts */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg">
            {error}
          </div>
        )}
        {successMsg && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
            {successMsg}
          </div>
        )}
        {infoMsg && (
          <div className="mb-4 p-3 bg-slate-50 border border-slate-200 text-slate-600 text-sm rounded-lg">
            {infoMsg}
          </div>
        )}

        {/* STEP 1: Email / Phone Input */}
        {step === 1 ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            
            {/* Method Switcher Tabs (Email vs Phone) */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-xl mb-4">
              <button
                type="button"
                onClick={() => { setAuthMethod('email'); setError(''); }}
                className={`flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition ${
                  authMethod === 'email' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600'
                }`}
              >
                <Mail size={16} /> Email OTP
              </button>
              <button
                type="button"
                onClick={() => { setAuthMethod('phone'); setError(''); }}
                className={`flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition ${
                  authMethod === 'phone' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600'
                }`}
              >
                <Phone size={16} /> Phone OTP
              </button>
            </div>

            {/* Name Field (Only for Registration) */}
            {!isLogin && (
              <div>
                <label
                  htmlFor="name"
                  className="block text-xs font-semibold uppercase text-slate-500 mb-1"
                >
                  Full Name
                </label>
                <input
                  id="name"
                  type="text"
                  name="name"
                  autoComplete="name"
                  placeholder="Enter your full name"
                  value={formData.name}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              </div>
            )}

            {/* Conditional Email or Phone Input */}
            {authMethod === 'email' ? (
              <div>
                <label
                  htmlFor="email"
                  className="block text-xs font-semibold uppercase text-slate-500 mb-1"
                >
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                  value={formData.email}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              </div>
            ) : (
              <div>
                <label
                  htmlFor="phone"
                  className="block text-xs font-semibold uppercase text-slate-500 mb-1"
                >
                  Contact Number
                </label>
                <div className="flex">
                  <span className="inline-flex items-center px-3 bg-slate-100 border border-r-0 border-slate-300 rounded-l-lg text-slate-600 text-sm">
                    +91
                  </span>
                  <input
                    id="phone"
                    type="tel"
                    name="phone"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    maxLength={10}
                    placeholder="9876543210"
                    value={formData.phone}
                    onChange={handleChange}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-r-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : <>Get OTP <ArrowRight size={16} /></>}
            </button>
          </form>
        ) : (
          /* STEP 2: OTP Verification Form */
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div>
              <label
                htmlFor="otp"
                className="block text-xs font-semibold uppercase text-slate-500 mb-1"
              >
                Enter 6-Digit OTP
              </label>
              <div className="relative">
                <input
                  id="otp"
                  type="text"
                  name="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="••••••"
                  value={formData.otp}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 text-center tracking-widest text-lg font-bold border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
                <ShieldCheck className="absolute right-3 top-3 text-slate-400" size={20} />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 rounded-lg transition flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : 'Verify & Continue'}
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleResend}
                disabled={loading || resendIn > 0}
                className="w-full text-sm text-blue-600 hover:underline py-1 disabled:text-slate-400 disabled:no-underline"
              >
                {loading ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Loader2 className="animate-spin" size={14} /> Sending
                  </span>
                ) : resendIn > 0 ? (
                  `Resend code in ${resendIn}s`
                ) : (
                  'Resend code'
                )}
              </button>
              <button
                type="button"
                onClick={() => { setStep(1); setSuccessMsg(''); setError(''); }}
                className="w-full text-sm text-slate-500 hover:text-slate-800 py-1"
              >
                ← Change {authMethod === 'email' ? 'Email' : 'Phone Number'}
              </button>
            </div>
          </form>
        )}

        {/* Divider */}
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200"></div>
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-2 text-slate-400">Or continue with</span>
          </div>
        </div>

        {/* Social OAuth Buttons (Google & Apple) */}
        <div className="grid grid-cols-2 gap-3">
          {isGoogleConfigured ? (
            <GoogleButton onLogin={handleGoogleLogin} />
          ) : (
            <button
              type="button"
              onClick={handleGoogleUnavailable}
              className={SOCIAL_BUTTON_CLASS}
            >
              <img
                src="https://www.svgrepo.com/show/475656/google-color.svg"
                alt=""
                className="w-5 h-5"
              />
              Google
            </button>
          )}

          <button
            type="button"
            onClick={handleAppleLogin}
            disabled={loading}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-black hover:bg-slate-900 text-white rounded-lg transition text-sm font-medium disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <img
                src="https://www.svgrepo.com/show/511330/apple-173.svg"
                alt=""
                className="w-5 h-5 invert"
              />
            )}
            Apple
          </button>
        </div>

        {/* Toggle Login / Signup */}
        <p className="text-center text-sm text-slate-600 mt-6">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button
            type="button"
            onClick={() => {
              setIsLogin(!isLogin);
              setStep(1);
              setError('');
              setSuccessMsg('');
            }}
            className="text-blue-600 font-semibold hover:underline"
          >
            {isLogin ? 'Register Now' : 'Login'}
          </button>
        </p>

      </div>
    </div>
  );
}