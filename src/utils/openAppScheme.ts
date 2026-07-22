/**
 * Launch a custom-scheme app deep link (happ://, v2rayng://, vless://, …) without
 * crashing the page inside in-app browsers.
 *
 * Why not always `window.location.href = scheme`: a programmatic top-level navigation
 * to a scheme the WebView can't resolve renders a full-page error on Android in-app
 * browsers (Telegram/Yandex/…) -- `net::ERR_UNKNOWN_URL_SCHEME` -- which destroys the
 * fallback UI (Telegram bug #654272). A hidden <iframe> navigation contains that
 * failure inside the (invisible) frame instead, leaving the page intact.
 *
 * iOS is the opposite case: WebKit does NOT reliably hand an iframe-triggered custom
 * scheme off to an installed app (Apple has progressively restricted this over
 * successive iOS releases as an anti-drive-by-launch measure), so the iframe route
 * left the button doing nothing even with the target app installed. Top-level
 * `location.href` is what actually works on iOS -- it either hands off to the
 * installed app, or (app missing) surfaces Safari's own "address is invalid" alert,
 * which is harmless chrome, not a page crash -- confirmed by the recovery site using
 * exactly this approach successfully. So iOS gets the direct navigation; Android and
 * other WebViews keep the iframe route.
 *
 * http(s) links are normal navigations and are passed straight to location.href.
 */
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

export function openAppScheme(url: string): void {
  const isHttp = /^https?:\/\//i.test(url);
  if (isHttp || isIOS) {
    window.location.href = url;
    return;
  }

  try {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        /* already detached */
      }
    }, 2000);
  } catch {
    // iframe creation blocked (very old/locked-down WebView) — fall back to direct
    // navigation. Worst case this shows the same error the iframe avoided, never worse.
    window.location.href = url;
  }
}
