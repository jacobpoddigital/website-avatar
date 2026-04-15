/**
 * re-engagement.js — Mid-session & exit-intent re-engagement card
 *
 * Shows a mini greeting card (avatar + message + Chat button) when the user
 * has been browsing without opening the chat. Two triggers:
 *   1. Inactivity — 45s of no interaction after minimum 10s on site
 *   2. Exit intent — cursor leaves viewport near the top (desktop only)
 *
 * Fires once per page load. No cross-page session gating — each navigation
 * is a fresh opportunity. Gate conditions: panel open, bridge connected,
 * or card already in DOM.
 *
 * Copy is page-aware: keyword matching on document.title + pathname determines
 * whether the user is on a service page, a conversion page, or a generic page,
 * and the message reflects that context.
 */

(function () {
  'use strict';

  // ── CONSTANTS ────────────────────────────────────────────────────────────────

  const MIN_ON_SITE   = 10 * 1000;   // must be on page at least 10s before card fires
  const INACTIVITY_MS = 45 * 1000;   // 45s idle triggers mid-session card
  const AUTO_DISMISS  = 12 * 1000;   // card auto-dismisses after 12s

  // ── LOGGING ──────────────────────────────────────────────────────────────────

  const _log = (...args) => window.WebsiteAvatar?.DEBUG && console.log('[WA:ReEngage]', ...args);

  // ── PAGE START ───────────────────────────────────────────────────────────────

  const _pageStart = Date.now();
  const _onSiteMs  = () => Date.now() - _pageStart;

  // ── PAGE CONTEXT ─────────────────────────────────────────────────────────────
  // Classifies the current page into one of three types based on title + path
  // keywords. Used to pick relevant copy without any backend call.

  function _getPageContext() {
    const title    = (document.title || '').toLowerCase();
    const path     = (window.location.pathname || '').toLowerCase();
    const combined = title + ' ' + path;

    const serviceKeywords    = ['service', 'chauffeur', 'fleet', 'vehicle', 'transfer', 'package', 'product', 'solution', 'offer'];
    const conversionKeywords = ['contact', 'price', 'pricing', 'quote', 'booking', 'book', 'enquir', 'request', 'get in touch', 'hire'];

    if (conversionKeywords.some(k => combined.includes(k))) return 'conversion';
    if (serviceKeywords.some(k => combined.includes(k)))    return 'service';
    return 'generic';
  }

  // Returns a short label for the current page — used inline in messages.
  function _getPageLabel() {
    const title = document.title || '';
    // Strip common suffixes like " | Brand Name" or " - Brand Name"
    return title.split(/[|\-–]/)[0].trim() || 'this page';
  }

  // ── COPY ─────────────────────────────────────────────────────────────────────

  function _getMessage(context) {
    const pageType  = _getPageContext();
    const pageLabel = _getPageLabel();

    const copy = {
      'mid-session': {
        service:    `Any questions about ${pageLabel}? I can help you find exactly what you need.`,
        conversion: `Ready to take the next step? I can walk you through the process quickly.`,
        generic:    `Couldn't find what you're looking for? Ask me anything.`,
      },
      'exit-intent': {
        service:    `Before you go — any questions about ${pageLabel} I can answer quickly?`,
        conversion: `Not quite ready? I can answer any questions before you decide.`,
        generic:    `Before you leave — is there anything I can help you with?`,
      },
    };

    const message = copy[context]?.[pageType] || copy[context]?.generic;
    _log(`Copy selected — context: "${context}", pageType: "${pageType}", pageLabel: "${pageLabel}"`);
    return message;
  }

  // ── GATE CHECK ───────────────────────────────────────────────────────────────

  function _shouldShow() {
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

    const message = _getMessage(context);
    const config  = window.WA_CONFIG || {};
    const name    = config.agentName  || 'Website Avatar';
    const avatar  = config.avatar_url || '';

    _log(`Showing card — context: "${context}", message: "${message}"`);

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
        const onSite = _onSiteMs();
        if (onSite >= MIN_ON_SITE) {
          _log(`Inactivity timer fired — ${INACTIVITY_MS / 1000}s idle, ${Math.round(onSite / 1000)}s on page — showing card`);
          _showCard('mid-session');
        } else {
          _log(`Inactivity timer fired but min on-site not met (${Math.round(onSite / 1000)}s < ${MIN_ON_SITE / 1000}s) — skipping`);
        }
      }, INACTIVITY_MS);
    }

    ['mousemove', 'scroll', 'keypress', 'click', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, _reset, { passive: true });
    });

    _log(`Inactivity trigger armed — fires after ${INACTIVITY_MS / 1000}s idle`);
    _reset();
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
      const onSite = _onSiteMs();
      if (onSite < MIN_ON_SITE) {
        _log(`Exit intent blocked — too soon (${Math.round(onSite / 1000)}s < ${MIN_ON_SITE / 1000}s min)`);
        return;
      }
      _log(`Exit intent triggered — clientY ${e.clientY}, ${Math.round(onSite / 1000)}s on page`);
      triggered = true;
      _showCard('exit-intent');
    });
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────

  _log(`Loaded — page context: "${_getPageContext()}", pageLabel: "${_getPageLabel()}"`);
  _initInactivity();
  _initExitIntent();

  // ── DEBUG HELPER ─────────────────────────────────────────────────────────────
  // Test the card from DevTools without waiting for timers:
  //
  //   WA_testReEngage()                  — mid-session, auto page context
  //   WA_testReEngage('exit-intent')     — exit-intent, auto page context
  //
  // Removes any existing card so you can fire it repeatedly.

  window.WA_testReEngage = function (context) {
    console.log('[WA:ReEngage] 🧪 Test triggered —', { context: context || 'mid-session' });
    const existing = document.getElementById('wa-re-engage');
    if (existing) existing.remove();
    _showCard(context || 'mid-session');
  };

})();
