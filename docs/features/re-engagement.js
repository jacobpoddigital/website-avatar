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

  // ── SESSION TIMER ────────────────────────────────────────────────────────────

  const _pageStart = Date.now();

  function _initTimer() {
    const now        = Date.now();
    const lastAct    = parseInt(localStorage.getItem(LAST_ACT_KEY) || '0');

    // New session if gap > 30 min
    if (now - lastAct > SESSION_GAP) {
      localStorage.setItem(ELAPSED_KEY, '0');
    }

    localStorage.setItem(LAST_ACT_KEY, String(now));

    // Flush elapsed time on page hide
    function _flush() {
      const stored  = parseInt(localStorage.getItem(ELAPSED_KEY) || '0');
      const added   = Date.now() - _pageStart;
      localStorage.setItem(ELAPSED_KEY, String(stored + added));
      localStorage.setItem(LAST_ACT_KEY, String(Date.now()));
    }

    document.addEventListener('visibilitychange', () => { if (document.hidden) _flush(); });
    window.addEventListener('pagehide', _flush);
  }

  function _elapsedMs() {
    const stored = parseInt(localStorage.getItem(ELAPSED_KEY) || '0');
    return stored + (Date.now() - _pageStart);
  }

  function _getTier() {
    const s = _elapsedMs() / 1000;
    if (s < 90)  return 'short';
    if (s < 240) return 'medium';
    return 'long';
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
    if (sessionStorage.getItem(SHOWN_KEY))              return false; // already shown
    if (document.getElementById('wa-re-engage'))        return false; // already visible
    const panel = document.getElementById('wa-panel');
    if (panel && panel.classList.contains('wa-open'))   return false; // chat is open
    const WA = window.WebsiteAvatar;
    if (WA && WA.bridge && WA.bridge.isConnected())     return false; // active session
    return true;
  }

  // ── CARD ─────────────────────────────────────────────────────────────────────

  function _showCard(context) {
    if (!_shouldShow()) return;

    const tier    = _getTier();
    const message = _copy[context][tier];
    const config  = window.WA_CONFIG || {};
    const name    = config.agentName  || 'Website Avatar';
    const avatar  = config.avatar_url || '';

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

    // Dismiss button
    card.querySelector('.wa-re-engage-close').onclick = () => {
      clearTimeout(timer);
      _dismiss(card);
    };

    // Chat button
    card.querySelector('.wa-re-engage-chat').onclick = () => {
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
        if (_elapsedMs() >= MIN_ON_SITE) {
          _showCard('mid-session');
        }
      }, INACTIVITY_MS);
    }

    ['mousemove', 'scroll', 'keypress', 'click', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, _reset, { passive: true });
    });

    _reset(); // start the clock
  }

  // ── EXIT INTENT TRIGGER ──────────────────────────────────────────────────────

  function _initExitIntent() {
    // Desktop only — cursor leaving near top of viewport
    let triggered = false;

    document.addEventListener('mouseleave', (e) => {
      if (triggered)          return;
      if (e.clientY >= 20)    return; // not heading for address bar / back button
      if (_elapsedMs() < MIN_ON_SITE) return; // too soon

      triggered = true;
      _showCard('exit-intent');
    });
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  _initTimer();
  _initInactivity();
  _initExitIntent();

})();
