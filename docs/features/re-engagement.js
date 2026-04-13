/**
 * re-engagement.js — Mid-session & exit-intent re-engagement card
 *
 * Shows a mini greeting card (avatar + message + Chat button) when the user
 * has been browsing without opening the chat. Two triggers:
 *   1. Inactivity — 60s of no interaction after minimum 30s on site
 *   2. Exit intent — cursor leaves viewport near the top (desktop only)
 *
 * Shown at most once per session (30-min gap = new session).
 */

(function () {
  'use strict';

  // ── CONSTANTS ────────────────────────────────────────────────────────────────

  const ELAPSED_KEY   = 'wa_session_elapsed';   // ms accumulated this session
  const LAST_ACT_KEY  = 'wa_last_activity';     // timestamp of last page load
  const SHOWN_KEY     = 'wa_re_engage_shown';   // sessionStorage — once per session
  const SESSION_GAP   = 30 * 60 * 1000;         // 30 min gap = new session
  const MIN_ON_SITE   = 30 * 1000;              // must have been on site 30s before exit fires
  const INACTIVITY_MS = 60 * 1000;              // 60s idle triggers mid-session card
  const AUTO_DISMISS  = 12 * 1000;              // card auto-dismisses after 12s

  // ── LOGGING ──────────────────────────────────────────────────────────────────
  // Gated on WA.DEBUG — enable via ?debug=1 or WA_CONFIG.debug: true

  const _log = (...args) => window.WebsiteAvatar?.DEBUG && console.log('[WA:ReEngage]', ...args);

  // ── SESSION TIMER ────────────────────────────────────────────────────────────

  const _pageStart = Date.now();

  function _initTimer() {
    const now     = Date.now();
    const lastAct = parseInt(localStorage.getItem(LAST_ACT_KEY) || '0');
    const gap     = now - lastAct;

    if (gap > SESSION_GAP) {
      localStorage.setItem(ELAPSED_KEY, '0');
      _log(`New session (gap ${Math.round(gap / 60000)}min > 30min) — elapsed reset to 0`);
    } else {
      _log(`Resuming session — prior elapsed: ${Math.round(parseInt(localStorage.getItem(ELAPSED_KEY) || '0') / 1000)}s, gap since last page: ${Math.round(gap / 1000)}s`);
    }

    localStorage.setItem(LAST_ACT_KEY, String(now));

    function _flush() {
      const stored = parseInt(localStorage.getItem(ELAPSED_KEY) || '0');
      const added  = Date.now() - _pageStart;
      localStorage.setItem(ELAPSED_KEY, String(stored + added));
      localStorage.setItem(LAST_ACT_KEY, String(Date.now()));
      _log(`Page hidden — flushed ${Math.round(added / 1000)}s, total elapsed now ${Math.round((stored + added) / 1000)}s`);
    }

    document.addEventListener('visibilitychange', () => { if (document.hidden) _flush(); });
    window.addEventListener('pagehide', _flush);
  }

  function _elapsedMs() {
    const stored = parseInt(localStorage.getItem(ELAPSED_KEY) || '0');
    return stored + (Date.now() - _pageStart);
  }

  function _getTier() {
    const s    = _elapsedMs() / 1000;
    const tier = s < 90 ? 'short' : s < 240 ? 'medium' : 'long';
    _log(`Tier check — elapsed ${Math.round(s)}s → "${tier}"`);
    return tier;
  }

  // ── COPY ─────────────────────────────────────────────────────────────────────

  const _copy = {
    'mid-session': {
      short:  "Couldn't find what you're looking for? I can help.",
      medium: "Still browsing? I can help you narrow things down.",
      long:   "You've been here a while — want a personalised recommendation?",
    },
    'exit-intent': {
      short:  "Before you go — any questions I can answer quickly?",
      medium: "Heading off? I can give you a quick summary of your options.",
      long:   "Don't leave without a recommendation — it only takes 30 seconds.",
    },
  };

  // ── GATE CHECK ───────────────────────────────────────────────────────────────

  function _shouldShow() {
    if (sessionStorage.getItem(SHOWN_KEY)) {
      _log('Gate blocked — already shown this session');
      return false;
    }
    if (document.getElementById('wa-re-engage')) {
      _log('Gate blocked — card already in DOM');
      return false;
    }
    const panel = document.getElementById('wa-panel');
    if (panel && panel.classList.contains('wa-open')) {
      _log('Gate blocked — chat panel is open');
      return false;
    }
    const WA = window.WebsiteAvatar;
    if (WA && WA.bridge && WA.bridge.isConnected()) {
      _log('Gate blocked — bridge is connected (active session)');
      return false;
    }
    return true;
  }

  // ── CARD ─────────────────────────────────────────────────────────────────────

  function _showCard(context) {
    _log(`showCard called — context: "${context}"`);
    if (!_shouldShow()) return;

    const tier    = _getTier();
    const message = _copy[context][tier];
    const config  = window.WA_CONFIG || {};
    const name    = config.agentName  || 'Website Avatar';
    const avatar  = config.avatar_url || '';

    _log(`Showing card — context: "${context}", tier: "${tier}", message: "${message}"`);
    sessionStorage.setItem(SHOWN_KEY, '1');

    const card = document.createElement('div');
    card.id        = 'wa-re-engage';
    card.className = 'wa-re-engage';
    card.innerHTML = `
      <button class="wa-re-engage-close" aria-label="Dismiss">×</button>
      <div class="wa-re-engage-orb">
        <div class="wa-orb wa-orb-speaking">
          <div class="wa-orb-blob"></div>
          ${avatar ? `<img src="${avatar}" alt="${name}" class="wa-orb-avatar" onerror="this.style.display='none'" />` : ''}
        </div>
      </div>
      <div class="wa-re-engage-name">${name} <span>AI</span></div>
      <div class="wa-re-engage-bubble"><p>${message}</p></div>
      <button class="wa-re-engage-chat">Start Chat</button>
    `;

    document.body.appendChild(card);

    // Animate in
    requestAnimationFrame(() => card.classList.add('wa-re-engage--visible'));

    // Auto-dismiss
    const timer = setTimeout(() => _dismiss(card), AUTO_DISMISS);

    // Auto-dismiss log
    setTimeout(() => _log('Card auto-dismissed after timeout'), AUTO_DISMISS);

    // Dismiss button
    card.querySelector('.wa-re-engage-close').onclick = () => {
      _log('Card dismissed by user (× button)');
      clearTimeout(timer);
      _dismiss(card);
    };

    // Chat button
    card.querySelector('.wa-re-engage-chat').onclick = () => {
      _log('Card dismissed — user clicked Start Chat');
      clearTimeout(timer);
      _dismiss(card);
      const WA = window.WebsiteAvatar;
      if (WA && WA.toggleChat) WA.toggleChat();
    };
  }

  function _dismiss(card) {
    card.classList.remove('wa-re-engage--visible');
    setTimeout(() => card.remove(), 350);
  }

  // ── INACTIVITY TRIGGER ───────────────────────────────────────────────────────

  function _initInactivity() {
    let timer = null;

    function _reset() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const elapsed = _elapsedMs();
        if (elapsed >= MIN_ON_SITE) {
          _log(`Inactivity timer fired — ${INACTIVITY_MS / 1000}s idle, elapsed ${Math.round(elapsed / 1000)}s — showing card`);
          _showCard('mid-session');
        } else {
          _log(`Inactivity timer fired but min on-site not met (${Math.round(elapsed / 1000)}s < ${MIN_ON_SITE / 1000}s) — skipping`);
        }
      }, INACTIVITY_MS);
    }

    ['mousemove', 'scroll', 'keypress', 'click', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, _reset, { passive: true });
    });

    _log(`Inactivity trigger armed — fires after ${INACTIVITY_MS / 1000}s idle`);
    _reset(); // start the clock
  }

  // ── EXIT INTENT TRIGGER ──────────────────────────────────────────────────────

  function _initExitIntent() {
    // Desktop only — cursor leaving near top of viewport
    let triggered = false;

    _log('Exit intent trigger armed — watching for mouseleave near top of viewport');

    document.addEventListener('mouseleave', (e) => {
      if (triggered) return;
      if (e.clientY >= 20) {
        _log(`mouseleave ignored — clientY ${e.clientY} (not near top)`);
        return;
      }
      const elapsed = _elapsedMs();
      if (elapsed < MIN_ON_SITE) {
        _log(`Exit intent blocked — too soon (${Math.round(elapsed / 1000)}s < ${MIN_ON_SITE / 1000}s min)`);
        return;
      }
      _log(`Exit intent triggered — clientY ${e.clientY}, elapsed ${Math.round(elapsed / 1000)}s`);
      triggered = true;
      _showCard('exit-intent');
    });
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  _initTimer();
  _log(`Loaded — elapsed this session: ${Math.round(_elapsedMs() / 1000)}s, tier: "${_getTier()}", shown flag: ${!!sessionStorage.getItem(SHOWN_KEY)}`);
  _initInactivity();
  _initExitIntent();

  // ── DEBUG HELPER ─────────────────────────────────────────────────────────────
  // Test the card from DevTools without waiting for timers:
  //
  //   WA_testReEngage()                        — mid-session, auto tier
  //   WA_testReEngage('exit-intent')           — exit-intent, auto tier
  //   WA_testReEngage('mid-session', 'long')   — force a specific tier
  //
  // Clears the session flag automatically so you can fire it repeatedly.

  window.WA_testReEngage = function (context, tier) {
    console.log('[WA:ReEngage] 🧪 Test triggered —', { context: context || 'mid-session', tier: tier || 'auto' });
    sessionStorage.removeItem(SHOWN_KEY);
    const existing = document.getElementById('wa-re-engage');
    if (existing) existing.remove();

    if (tier) {
      const tierMs = { short: 0, medium: 100000, long: 300000 };
      localStorage.setItem(ELAPSED_KEY, String(tierMs[tier] ?? 0));
      console.log('[WA:ReEngage] 🧪 Elapsed overridden to force tier:', tier);
    }

    _showCard(context || 'mid-session');
  };

})();
