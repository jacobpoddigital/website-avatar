/**
 * core/auth.js — Magic Link Authentication
 * Manages wa_auth_token in localStorage; exposes getCurrentUser and requestMagicLink.
 * Must load before session-sync.js.
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  const AUTH_TOKEN_KEY = 'wa_auth_token';
  const MAGIC_LINK_URL = 'https://backend.jacob-e87.workers.dev/auth/magic-link';

  // ─── JWT HELPERS ─────────────────────────────────────────────────────────

  function parseJWT(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded  = payload + '='.repeat((4 - payload.length % 4) % 4);
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  function isTokenValid(token) {
    if (!token) return false;
    const payload = parseJWT(token);
    if (!payload || !payload.exp) return false;
    return payload.exp * 1000 > Date.now();
  }

  // ─── AUTH STATE ───────────────────────────────────────────────────────────

  function getCurrentUser() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token && isTokenValid(token)) {
      const payload = parseJWT(token);
      return {
        id:              payload.sub,
        email:           payload.email,
        token,
        isAuthenticated: true
      };
    }
    // Anonymous visitor — fall back to wc_visitor
    const visitorId = localStorage.getItem('wc_visitor') || null;
    return {
      id:              visitorId,
      email:           null,
      token:           null,
      isAuthenticated: false
    };
  }

  // ─── MAGIC LINK REQUEST ───────────────────────────────────────────────────

  async function requestMagicLink(email) {
    if (!isValidEmail(email)) return { success: false, error: 'Invalid email' };

    const user    = getCurrentUser();
    const session = WA.getSession ? WA.getSession() : {};

    const payload = {
      email,
      visitor_id:      user.isAuthenticated ? null : user.id,
      conversation_id: session.dialogueConversationId || null,
      origin:          window.location.href
    };

    try {
      const res = await fetch(MAGIC_LINK_URL, {
        method:  'POST',
        signal:  AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Request failed' };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ─── EMAIL VALIDATION / EXTRACTION ───────────────────────────────────────

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function extractEmail(text) {
    const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    return match ? match[0] : null;
  }

  // ─── HASH INTERCEPT ───────────────────────────────────────────────────────
  // After clicking the magic link, the worker redirects to:
  //   https://your-site.com/page#wa_auth=TOKEN
  // This function intercepts that hash on page load, stores the token, cleans the URL.

  function interceptAuthHash() {
    const hash = window.location.hash;
    if (!hash.includes('wa_auth=')) return;

    const match = hash.match(/wa_auth=([^&]+)/);
    if (!match) return;

    const token = match[1];
    if (isTokenValid(token)) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      const user = parseJWT(token);
      console.log('[Auth] ✅ Authenticated as:', user?.email);

      // Clean the hash from the URL without triggering a reload
      const cleanUrl = window.location.href.replace(/#wa_auth=[^&]*(&|$)/, '').replace(/#$/, '');
      history.replaceState(null, '', cleanUrl);
    } else {
      console.warn('[Auth] ⚠️ Received invalid or expired auth token in URL hash');
    }
  }

  // Run immediately — must happen before WA initialises so getUserId() sees the token
  interceptAuthHash();

  // ─── SIGN OUT ─────────────────────────────────────────────────────────────

  function signOut() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.auth = {
    getCurrentUser,
    requestMagicLink,
    signOut,
    parseJWT,
    isTokenValid,
    isValidEmail,
    extractEmail
  };

  console.log('[Auth] ✅ Module ready | Authenticated:', getCurrentUser().isAuthenticated);

})();
