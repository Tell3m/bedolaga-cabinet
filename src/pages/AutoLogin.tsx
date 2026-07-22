import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { XIcon, CheckCircleIcon } from '@/components/icons';
import type { AuthResponse } from '../types';

export default function AutoLogin() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setTokens, setUser, checkAdminStatus } = useAuthStore();
  const [error, setError] = useState(false);
  const [bridgeAuth, setBridgeAuth] = useState<AuthResponse | null>(null);
  const [opening, setOpening] = useState(false);
  const attemptedRef = useRef(false);

  const token = searchParams.get('token');
  const pollToken = searchParams.get('poll_token');

  useEffect(() => {
    // Prevent referrer leaking the token
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    if (!token || attemptedRef.current) {
      if (!token) setError(true);
      return;
    }
    attemptedRef.current = true;

    authApi
      .autoLogin(token)
      .then(async (response) => {
        // If this link was requested from a magic-link login (poll_token
        // present), the ORIGINAL requesting browser/tab is almost always a
        // different context (e.g. Mail app's in-app browser vs. an iOS
        // home-screen PWA icon) that is already polling and will log itself
        // in automatically once we confirm below. Opening a second, fully
        // logged-in cabinet HERE too would just leave stray active sessions
        // scattered across every place a link was ever tapped -- so this
        // browser only confirms and shows a bridge screen, it does not
        // become a logged-in session unless the user explicitly asks to
        // via the fallback button.
        if (pollToken) {
          try {
            await authApi.confirmMagicLink(pollToken);
          } catch {
            // Non-fatal -- the token exchange above already proved the
            // link is valid; confirm is just best-effort delivery to the
            // other browser.
          }
          setBridgeAuth(response);
          return;
        }

        setTokens(response.access_token, response.refresh_token);
        setUser(response.user);
        await checkAdminStatus();
        navigate('/', { replace: true });
      })
      .catch(() => {
        setError(true);
      });
  }, [token, pollToken, navigate, setTokens, setUser, checkAdminStatus]);

  const openHere = useCallback(async () => {
    if (!bridgeAuth || opening) return;
    setOpening(true);
    setTokens(bridgeAuth.access_token, bridgeAuth.refresh_token);
    setUser(bridgeAuth.user);
    await checkAdminStatus();
    navigate('/', { replace: true });
  }, [bridgeAuth, opening, navigate, setTokens, setUser, checkAdminStatus]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-dark-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-dark-800/50 bg-dark-900/50 p-8 text-center">
        {error ? (
          <div className="space-y-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-error-500/10">
              <XIcon className="h-8 w-8 text-error-400" />
            </div>
            <p className="text-sm text-dark-300">{t('landing.autoLoginFailed')}</p>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className="rounded-xl bg-accent-500 px-6 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-400"
            >
              {t('auth.login', 'Login')}
            </button>
          </div>
        ) : bridgeAuth ? (
          <div className="space-y-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-500/10">
              <CheckCircleIcon className="h-8 w-8 text-success-400" />
            </div>
            <p className="text-sm font-medium text-white">
              {t('auth.magicLinkBridgeTitle', 'Вход подтверждён')}
            </p>
            <p className="text-xs leading-relaxed text-dark-400">
              {t(
                'auth.magicLinkBridgeBody',
                'Вернитесь туда, откуда вы входили, — доступ откроется автоматически через пару секунд. Эту вкладку можно закрыть.',
              )}
            </p>
            <button
              type="button"
              onClick={openHere}
              disabled={opening}
              className="w-full rounded-xl border border-dark-700 px-6 py-2.5 text-xs font-medium text-dark-300 transition-colors hover:bg-dark-800 disabled:opacity-50"
            >
              {t('auth.magicLinkBridgeOpenHere', 'Открыть кабинет в этом браузере')}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-dark-600 border-t-accent-500" />
            <p className="text-sm text-dark-300">{t('landing.autoLoginProcessing')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
