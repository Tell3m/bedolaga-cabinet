import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useAuthStore } from '../store/auth';
import { useShallow } from 'zustand/shallow';
import { authApi } from '../api/auth';
import { isValidEmail } from '../utils/validation';
import {
  brandingApi,
  getCachedBranding,
  setCachedBranding,
  preloadLogo,
  isLogoPreloaded,
  type BrandingInfo,
  type EmailAuthEnabled,
} from '../api/branding';
import { getAndClearReturnUrl, tokenStorage } from '../utils/token';
import { getApiErrorMessage } from '../utils/api-error';
import { isInTelegramWebApp, getTelegramInitData, useTelegramSDK } from '../hooks/useTelegramSDK';
import { closeMiniApp } from '@telegram-apps/sdk-react';
import LanguageSwitcher from '../components/LanguageSwitcher';
import TelegramLoginButton from '../components/TelegramLoginButton';
import OAuthProviderIcon from '../components/OAuthProviderIcon';
import { saveOAuthState } from '../utils/oauth';
import { getPendingReferralCode } from '../utils/referral';
import { UsersIcon, EmailIcon, RefreshIcon } from '@/components/icons';
import LegalFooter from '../components/LegalFooter';

// OAuth providers (Yandex, etc) are hidden for now -- not removed, just
// not rendered. Flip back to true to bring the row back.
const SHOW_OAUTH_PROVIDERS = false;

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    isAuthenticated,
    isLoading: isAuthInitializing,
    loginWithTelegram,
    loginWithMagicLinkPoll,
  } = useAuthStore(
    useShallow((state) => ({
      isAuthenticated: state.isAuthenticated,
      isLoading: state.isLoading,
      loginWithTelegram: state.loginWithTelegram,
      loginWithMagicLinkPoll: state.loginWithMagicLinkPoll,
    })),
  );

  // Get referral code from localStorage (captured from ?ref= param at module level in auth store)
  const referralCode = getPendingReferralCode() || '';

  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isTelegramWebApp, setIsTelegramWebApp] = useState(false);
  const [logoLoaded, setLogoLoaded] = useState(() => isLogoPreloaded());
  const [magicLinkEmail, setMagicLinkEmail] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [magicLinkLoading, setMagicLinkLoading] = useState(false);
  const [magicLinkError, setMagicLinkError] = useState('');

  // Telegram safe area insets
  const { safeAreaInset, contentSafeAreaInset } = useTelegramSDK();
  const safeTop = Math.max(safeAreaInset.top, contentSafeAreaInset.top);
  const safeBottom = Math.max(safeAreaInset.bottom, contentSafeAreaInset.bottom);

  // Получаем URL для возврата после авторизации
  const getReturnUrl = useCallback(() => {
    // Сначала проверяем state от React Router
    const stateFrom = (location.state as { from?: string })?.from;
    if (stateFrom && stateFrom !== '/login') {
      return stateFrom;
    }
    // Затем проверяем сохранённый URL в sessionStorage (от safeRedirectToLogin)
    const savedUrl = getAndClearReturnUrl();
    if (savedUrl && savedUrl !== '/login') {
      return savedUrl;
    }
    // По умолчанию на главную
    return '/';
  }, [location.state]);

  // Fetch branding with unified cache
  const cachedBranding = useMemo(() => getCachedBranding(), []);

  const { data: branding } = useQuery<BrandingInfo>({
    queryKey: ['branding'],
    queryFn: async () => {
      const data = await brandingApi.getBranding();
      setCachedBranding(data);
      await preloadLogo(data);
      return data;
    },
    staleTime: 60000,
    initialData: cachedBranding ?? undefined,
    initialDataUpdatedAt: 0,
  });

  // Check if email auth is enabled
  const { data: emailAuthConfig } = useQuery<EmailAuthEnabled>({
    queryKey: ['email-auth-enabled'],
    queryFn: brandingApi.getEmailAuthEnabled,
    staleTime: 60000,
  });
  const isEmailAuthEnabled = emailAuthConfig?.enabled ?? true;

  const { data: footerEnabled } = useQuery({
    queryKey: ['footer-enabled'],
    queryFn: brandingApi.getFooterEnabled,
    staleTime: 60000,
  });

  // Fetch enabled OAuth providers (rendered only when SHOW_OAUTH_PROVIDERS)
  const { data: oauthData } = useQuery({
    queryKey: ['oauth-providers'],
    queryFn: authApi.getOAuthProviders,
    staleTime: 60000,
  });
  const oauthProviders = Array.isArray(oauthData?.providers) ? oauthData.providers : [];

  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  const handleOAuthLogin = async (provider: string) => {
    setError('');
    setOauthLoading(provider);
    try {
      const { authorize_url, state } = await authApi.getOAuthAuthorizeUrl(provider);

      // Validate redirect URL — only allow HTTPS to prevent open redirect
      let parsed: URL;
      try {
        parsed = new URL(authorize_url);
      } catch {
        throw new Error('Invalid OAuth redirect URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new Error('Invalid OAuth redirect URL');
      }

      saveOAuthState(state, provider);
      window.location.href = authorize_url;
    } catch {
      setError(t('auth.oauthError', 'Authorization was denied or failed'));
      setOauthLoading(null);
    }
  };

  const appName = branding ? branding.name : import.meta.env.VITE_APP_NAME || 'VPN';
  const appLogo = branding?.logo_letter || import.meta.env.VITE_APP_LOGO || 'V';
  const logoUrl = branding ? brandingApi.getLogoUrl(branding) : null;

  // Set document title
  useEffect(() => {
    document.title = appName || 'VPN';
  }, [appName]);

  useEffect(() => {
    if (isAuthenticated) {
      navigate(getReturnUrl(), { replace: true });
    }
  }, [isAuthenticated, navigate, getReturnUrl]);

  // Try Telegram WebApp authentication on mount (with auto-retry on 401)
  // Wait for auth store initialization to complete to avoid race conditions
  // with stale tokens triggering interceptor refresh/redirect loops
  useEffect(() => {
    // Don't attempt Telegram auth until store initialization is done
    if (isAuthInitializing) return;

    const tryTelegramAuth = async () => {
      const initData = getTelegramInitData();
      if (!isInTelegramWebApp() || !initData) return;

      setIsTelegramWebApp(true);
      setIsLoading(true);

      const MAX_RETRIES = 1;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await loginWithTelegram(initData);
          navigate(getReturnUrl(), { replace: true });
          return;
        } catch (err) {
          const error = err as { response?: { status?: number } };
          const status = error.response?.status;
          const detail = getApiErrorMessage(err, '');
          if (import.meta.env.DEV)
            console.warn(`Telegram auth attempt ${attempt + 1} failed:`, status, detail);

          if (status === 401 && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }

          // Show backend error detail if available, otherwise generic message
          setError(detail || t('auth.telegramRequired'));
        }
      }

      setIsLoading(false);
    };

    tryTelegramAuth();
  }, [isAuthInitializing, loginWithTelegram, navigate, t, getReturnUrl]);

  const handleRetryTelegramAuth = () => {
    // Clear ALL cached auth state to prevent stale token/initData loops
    tokenStorage.clearTokens();
    sessionStorage.removeItem('tapps/launchParams');
    sessionStorage.removeItem('telegram_init_data');
    localStorage.removeItem('cabinet-auth');
    localStorage.removeItem('tg_user_id');

    try {
      // Close miniapp — Telegram will provide fresh initData on reopen
      closeMiniApp();
    } catch {
      // If closeMiniApp fails, force a clean page reload
      window.location.reload();
    }
  };

  const MAGIC_LINK_POLL_INTERVAL_MS = 2500;
  const magicLinkPollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const magicLinkPollInFlightRef = useRef(false);
  const magicLinkMountedRef = useRef(true);

  useEffect(() => {
    magicLinkMountedRef.current = true;
    return () => {
      magicLinkMountedRef.current = false;
      if (magicLinkPollTimeoutRef.current) clearTimeout(magicLinkPollTimeoutRef.current);
    };
  }, []);

  // Polls from the SAME browser that requested the link -- so that once
  // the link is opened anywhere (even a different browser/device: Mail
  // app's in-app browser vs. an iOS home-screen icon, say), this tab logs
  // itself in automatically instead of leaving the user stuck on whatever
  // opened the click.
  const startMagicLinkPoll = useCallback(
    (pollToken: string) => {
      if (magicLinkPollTimeoutRef.current) {
        clearTimeout(magicLinkPollTimeoutRef.current);
        magicLinkPollTimeoutRef.current = null;
      }
      magicLinkPollInFlightRef.current = false;

      const poll = async () => {
        if (!magicLinkMountedRef.current || magicLinkPollInFlightRef.current) return;
        magicLinkPollInFlightRef.current = true;
        try {
          await loginWithMagicLinkPoll(pollToken);
          // Success -- auth store is updated; the isAuthenticated effect
          // above handles navigation.
        } catch (err: unknown) {
          if (!magicLinkMountedRef.current) return;
          if (isAxiosError(err) && err.response?.status === 202) {
            magicLinkPollTimeoutRef.current = setTimeout(poll, MAGIC_LINK_POLL_INTERVAL_MS);
            return;
          }
          if (isAxiosError(err) && err.response?.status === 410) {
            setMagicLinkError(
              t('auth.magicLinkExpired', 'This link has expired. Request a new one.'),
            );
            return;
          }
          // Transient/network error -- keep trying, the link itself is
          // still valid server-side even if this particular poll failed.
          magicLinkPollTimeoutRef.current = setTimeout(poll, MAGIC_LINK_POLL_INTERVAL_MS);
        } finally {
          magicLinkPollInFlightRef.current = false;
        }
      };

      magicLinkPollTimeoutRef.current = setTimeout(poll, MAGIC_LINK_POLL_INTERVAL_MS);
    },
    [loginWithMagicLinkPoll, t],
  );

  const handleMagicLink = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setMagicLinkError('');

    if (!magicLinkEmail.trim() || !isValidEmail(magicLinkEmail.trim())) {
      setMagicLinkError(t('auth.invalidEmail', 'Please enter a valid email address'));
      return;
    }

    setMagicLinkLoading(true);
    try {
      const result = await authApi.requestMagicLink(magicLinkEmail.trim());
      setMagicLinkSent(true);
      if (result.poll_token) {
        startMagicLinkPoll(result.poll_token);
      }
    } catch (err: unknown) {
      setMagicLinkError(getApiErrorMessage(err, t('common.error')));
    } finally {
      setMagicLinkLoading(false);
    }
  };

  const resetMagicLink = () => {
    if (magicLinkPollTimeoutRef.current) {
      clearTimeout(magicLinkPollTimeoutRef.current);
      magicLinkPollTimeoutRef.current = null;
    }
    setMagicLinkEmail('');
    setMagicLinkSent(false);
    setMagicLinkError('');
  };

  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center px-4 sm:px-6 lg:px-8"
      style={{
        paddingTop:
          safeTop > 0 ? `${safeTop + 16}px` : 'calc(1rem + env(safe-area-inset-top, 0px))',
        paddingBottom:
          safeBottom > 0 ? `${safeBottom + 16}px` : 'calc(1rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {/* Flat background — the previous two layered gradients (linear
          + accent radial halo) read as the airdrop / crypto aesthetic
          PRODUCT.md explicitly anti-references. Body bg-dark-950 carries
          the surface alone. */}

      {/* Language switcher */}
      <div
        className="fixed right-3 z-50"
        style={{
          top: safeTop > 0 ? `${safeTop + 12}px` : 'calc(12px + env(safe-area-inset-top, 0px))',
        }}
      >
        <LanguageSwitcher />
      </div>

      <div className="relative w-full max-w-md space-y-5">
        {/* Logo & branding */}
        <div className="text-center">
          <div className="relative mx-auto mb-3 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-dark-700/50 bg-dark-800/80 shadow-md">
            {/* Letter fallback */}
            <span
              className={`absolute text-lg font-bold text-accent-400 transition-opacity duration-200 ${branding?.has_custom_logo && logoLoaded ? 'opacity-0' : 'opacity-100'}`}
            >
              {appLogo}
            </span>
            {/* Logo image */}
            {branding?.has_custom_logo && logoUrl && (
              <img
                src={logoUrl}
                alt={appName || 'Logo'}
                className={`absolute h-full w-full object-contain transition-opacity duration-200 ${logoLoaded ? 'opacity-100' : 'opacity-0'}`}
                onLoad={() => setLogoLoaded(true)}
              />
            )}
          </div>
          {appName && <h1 className="text-2xl font-bold text-dark-50">{appName}</h1>}

          {/* Referral Banner */}
          {referralCode && isEmailAuthEnabled && (
            <div className="mt-3 rounded-xl border border-accent-500/30 bg-accent-500/10 p-2.5">
              <div className="flex items-center justify-center gap-2 text-accent-400">
                <UsersIcon className="h-4 w-4 flex-shrink-0" />
                <span className="text-xs font-medium">{t('auth.referralInvite')}</span>
              </div>
            </div>
          )}
        </div>

        {/* Main auth card */}
        <div className="card">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-error-500/30 bg-error-500/10 px-4 py-2.5 text-sm text-error-400"
            >
              {error}
            </div>
          )}

          {/* Telegram auth section */}
          <div className="space-y-3">
            {isLoading && isTelegramWebApp ? (
              <div className="py-6 text-center">
                <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-accent-500 border-t-transparent" />
                <p className="text-sm text-dark-400">{t('auth.authenticating')}</p>
              </div>
            ) : isTelegramWebApp && error ? (
              <div className="space-y-3 text-center">
                <button
                  onClick={handleRetryTelegramAuth}
                  className="btn-primary mx-auto flex items-center gap-2 px-5 py-2.5"
                >
                  <RefreshIcon className="h-4 w-4" />
                  {t('auth.tryAgain')}
                </button>
                <p className="text-xs text-dark-500">
                  {t(
                    'auth.telegramReopenHint',
                    'If the problem persists, close and reopen the app',
                  )}
                </p>
              </div>
            ) : (
              <TelegramLoginButton referralCode={referralCode || undefined} />
            )}
          </div>

          {/* OAuth providers - hidden for now, see SHOW_OAUTH_PROVIDERS */}
          {SHOW_OAUTH_PROVIDERS && oauthProviders.length > 0 && (
            <>
              <div className="my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-dark-700" />
                <span className="text-xs text-dark-500">{t('auth.or', 'or')}</span>
                <div className="h-px flex-1 bg-dark-700" />
              </div>
              <div className="flex items-stretch gap-2">
                {oauthProviders.map((provider) => (
                  <button
                    key={provider.name}
                    type="button"
                    onClick={() => handleOAuthLogin(provider.name)}
                    disabled={oauthLoading !== null}
                    className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dark-700 bg-dark-800/80 py-2.5 transition-all hover:border-dark-600 hover:bg-dark-700 disabled:opacity-50"
                    title={provider.display_name}
                  >
                    {oauthLoading === provider.name ? (
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-dark-400 border-t-white" />
                    ) : (
                      <OAuthProviderIcon provider={provider.name} className="h-5 w-5" />
                    )}
                    <span className="text-[10px] leading-none text-dark-500">
                      {provider.display_name}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Email: magic-link only -- no password, no separate registration.
              Same visual weight as the Telegram button above so the two
              read as equal options, not primary + buried fallback. */}
          {isEmailAuthEnabled && (
            <>
              <div className="my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-dark-700" />
                <span className="text-xs text-dark-500">{t('auth.or', 'or')}</span>
                <div className="h-px flex-1 bg-dark-700" />
              </div>

              {magicLinkSent ? (
                <div className="space-y-4 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-success-500/20">
                    <EmailIcon className="h-6 w-6 text-success-400" />
                  </div>
                  <p className="text-sm font-medium text-dark-100">
                    {t('auth.checkEmail', 'Check your email')}
                  </p>
                  <p className="text-xs text-dark-400">
                    {t(
                      'auth.magicLinkSent',
                      'If this email is valid, we sent a login link. Open it to sign in.',
                    )}
                  </p>
                  {!magicLinkError && (
                    <p className="flex items-center justify-center gap-2 text-xs text-dark-500">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-dark-600 border-t-accent-500" />
                      {t('auth.magicLinkWaiting', 'Waiting for you to open the link…')}
                    </p>
                  )}
                  {magicLinkError && <p className="text-sm text-error-400">{magicLinkError}</p>}
                  <button
                    type="button"
                    onClick={resetMagicLink}
                    className="text-sm text-accent-400 transition-colors hover:text-accent-300"
                  >
                    {t('common.back', 'Back')}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleMagicLink} className="space-y-3" noValidate>
                  <div>
                    <label htmlFor="magicLinkEmail" className="label">
                      Email
                    </label>
                    <input
                      id="magicLinkEmail"
                      type="email"
                      autoComplete="email"
                      className="input"
                      placeholder="you@example.com"
                      value={magicLinkEmail}
                      onChange={(e) => setMagicLinkEmail(e.target.value)}
                    />
                  </div>
                  {magicLinkError && <p className="text-sm text-error-400">{magicLinkError}</p>}
                  <button
                    type="submit"
                    disabled={magicLinkLoading}
                    className="btn-primary w-full py-2.5"
                  >
                    {magicLinkLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        {t('common.loading')}
                      </span>
                    ) : (
                      t('auth.loginWithMagicLink', 'Log in with a link (no password)')
                    )}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
        {footerEnabled && <LegalFooter className="pt-1" />}
      </div>
    </div>
  );
}
