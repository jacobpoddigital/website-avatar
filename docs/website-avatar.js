/**
 * website-avatar.js — Website Avatar by AdVelocity
 * Single script tag deployment. Fetches config from backend by account ID.
 *
 * Usage:
 * <script src="https://jacobpoddigital.github.io/website-avatar/website-avatar.js"
 *         data-account-id="acct_poddigital">
 * </script>
 */

(function () {

  // ── GUARD AGAINST DOUBLE LOADING ────────────────────────────────────────
  if (window._waLoaded) {
    console.warn('[WA] website-avatar.js loaded twice — ignoring duplicate');
    return;
  }
  window._waLoaded = true;

  const thisScript = document.currentScript;
  const BASE_URL   = thisScript.src.replace('/website-avatar.js', '');
  const accountId  = thisScript.getAttribute('data-account-id') || '';

  // Backend config endpoint — always this Worker
  const CONFIG_URL = 'https://backend.jacob-e87.workers.dev/config';
  // OpenAI proxy — always this Worker, never exposed in script tag
  const PROXY_URL  = 'https://backend.jacob-e87.workers.dev/classify';
  // Session sync endpoint — always this Worker
  const SESSION_URL = 'https://backend.jacob-e87.workers.dev/session';

  // ── INJECT GREETING WIDGET HTML ─────────────────────────────────────────
  function injectGreeting(config = {}) {
    if (document.getElementById('wa-greeting')) return;

    const agentName = config.agentName || 'Website Avatar';
    const avatarUrl = config.avatar_url || '';
    const greetingMessage = config.greetingMessage || 
      `Hi, I'm ${config.agentName || 'Mike'} - founder of ${config.businessName || 'Pod Digital'}. This AI version of me is trained on everything we do. Can we have a quick chat?`;

    const greeting = document.createElement('div');
    greeting.id = 'wa-greeting';
    greeting.innerHTML = `
      <div class="wa-greeting-overlay"></div>
      <div class="wa-greeting-container">
        <button class="wa-greeting-close" data-action="close" aria-label="Close">
          ✕
        </button>
        ${avatarUrl ? `<img src="${avatarUrl}" alt="${agentName}" class="wa-greeting-avatar" />` : ''}
        <div class="wa-greeting-bubble">
          <p>${greetingMessage}</p>
        </div>
        <div class="wa-greeting-actions">
          <button class="wa-greeting-btn" data-action="start">
            <div class="wa-greeting-btn-label">Start Chat</div>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(greeting);
  }

  // ── INJECT WIDGET HTML ───────────────────────────────────────────────────
  function injectHTML(agentName, config = {}) {
    const name = agentName || 'Website Avatar';
    const avatarUrl = config.avatar_url || '';

    if (!document.getElementById('wa-transition')) {
      const overlay = document.createElement('div');
      overlay.id = 'wa-transition';
      overlay.innerHTML = '<div class="wa-nav-label"></div>';
      document.body.appendChild(overlay);
    }

    if (!document.getElementById('wa-bubble')) {
      const bubble = document.createElement('button');
      bubble.id = 'wa-bubble';
      bubble.innerHTML = avatarUrl
        ? `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" /><div class="wa-badge" id="wa-badge"></div>`
        : '💬<div class="wa-badge" id="wa-badge"></div>';
      bubble.onclick = () => window.WebsiteAvatar && WebsiteAvatar.toggleChat();
      document.body.appendChild(bubble);
    }

    if (!document.getElementById('wa-panel')) {
      const panel = document.createElement('div');
      panel.id = 'wa-panel';
      const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" alt="${name}" class="wa-header-avatar" />` : '';
      panel.innerHTML = `
        <div class="wa-header">
          <div class="wa-header-info">
            ${avatarHtml}
            <div>
              <h4>${name}</h4>
              <span id="wa-status-label">Offline</span>
            </div>
          </div>
          <button class="wa-history-btn" id="wa-history-btn" aria-label="View past conversations" title="Past conversations">•••</button>
        </div>
        <div class="wa-messages" id="wa-messages"></div>
        <div class="wa-consent-banner" id="wa-consent-banner">
          <p class="wa-consent-text">
            This chat uses an AI to provide responses. Messages will be stored
            and processed, and may be used to improve our service.
            See our <a href="/privacy-policy" target="_blank" rel="noopener" class="wa-consent-link">Privacy Policy</a>.
          </p>
          <button id="wa-consent-btn" class="wa-consent-start-btn">Start Chat</button>
        </div>
        <div class="wa-input-row">
          <input type="text" id="wa-input" placeholder="Type a message…" disabled />
          <button id="wa-send" disabled>Send</button>
        </div>
        <div class="wa-history-panel" id="wa-history-panel" aria-hidden="true">
          <div class="wa-history-header">
            <span class="wa-history-title">Past Conversations</span>
            <button class="wa-history-close" id="wa-history-close" aria-label="Close">✕</button>
          </div>
          <div class="wa-history-list" id="wa-history-list"></div>
        </div>
        <div class="wa-history-view" id="wa-history-view" aria-hidden="true">
          <div class="wa-history-view-header">
            <button class="wa-history-back" id="wa-history-back" aria-label="Back to list">← Back</button>
            <span class="wa-history-view-date" id="wa-history-view-date"></span>
          </div>
          <div class="wa-history-view-msgs" id="wa-history-view-msgs"></div>
        </div>
      `;
      document.body.appendChild(panel);

      panel.querySelector('#wa-send').onclick    = () => WebsiteAvatar.sendMessage();
      panel.querySelector('#wa-input').onkeydown = (e) => WebsiteAvatar.handleKey(e);
      panel.querySelector('#wa-history-btn').onclick   = () => WebsiteAvatar.openHistoryPanel?.();
      panel.querySelector('#wa-history-close').onclick = () => WebsiteAvatar.closeHistoryPanel?.();
      panel.querySelector('#wa-history-back').onclick  = () => WebsiteAvatar.closeHistorySession?.();

      // ── GDPR CONSENT ──────────────────────────────────────────────────────
      // Check if the user has already consented in a previous session.
      const CONSENT_KEY = 'wa_gdpr_consent';
      const CONSENT_URL = 'https://backend.jacob-e87.workers.dev/consent';

      if (localStorage.getItem(CONSENT_KEY)) {
        _applyConsent(panel);
      } else {
        panel.querySelector('#wa-consent-btn').onclick = async () => {
          const visitorId = localStorage.getItem('wc_visitor') || '';

          // Persist consent to the backend compliance log.
          // The /consent endpoint inserts a row into the D1 `consent` table.
          try {
            const res = await fetch(CONSENT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ visitor_id: visitorId, consent_given: true }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
              console.warn('[WA] Consent record failed:', data.error || res.status);
              // Non-blocking: still allow the user to chat even if logging fails.
            }
          } catch (e) {
            // Network failure — log locally and continue; do not block the user.
            console.warn('[WA] Consent POST error:', e.message);
          }

          localStorage.setItem(CONSENT_KEY, new Date().toISOString());
          _applyConsent(panel);
        };
      }

      function _applyConsent(panel) {
        const banner = panel.querySelector('#wa-consent-banner');
        const input  = panel.querySelector('#wa-input');
        const send   = panel.querySelector('#wa-send');
        if (banner) banner.style.display = 'none';
        if (input)  input.disabled = false;
        if (send)   send.disabled  = false;
        if (input)  input.focus();
      }
    }
  }

  // ── LOAD SCRIPTS ────────────────────────────────────────────────────────
  function loadScript(src, isModule) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.defer = true;
      if (isModule) s.type = 'module';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  // ── BOOT ────────────────────────────────────────────────────────────────
  async function boot() {
    // ── WAIT FOR VISITOR ID ──────────────────────────────────────────────
    function waitForVisitorId(callback, attempts = 0) {
      const visitorId = localStorage.getItem('wc_visitor');
      
      if (visitorId) {
        console.log('[WA] ✅ Visitor ID found:', visitorId);
        callback();
      } else if (attempts < 50) { // 5 seconds max (50 × 100ms)
        setTimeout(() => waitForVisitorId(callback, attempts + 1), 100);
      } else {
        console.warn('[WA] ⚠️ Visitor ID not found after 5s, loading anyway');
        callback();
      }
    }

    function initWidget() {
      loadWidgetScripts();
    }

    async function loadWidgetScripts() {
      try {
        let config = {};
        if (accountId) {
          try {
            const res = await fetch(`${CONFIG_URL}?id=${accountId}`);
            if (res.ok) config = await res.json();
            else console.warn('[WA] Config not found for account:', accountId);
          } catch(e) {
            console.warn('[WA] Could not fetch config:', e.message);
          }
        } else {
          console.warn('[WA] No data-account-id provided on script tag');
        }

        window.WA_CONFIG = {
          elevenlabsAgentId: config.elevenlabsAgentId || '',
          openaiProxyUrl:    PROXY_URL,
          sessionUrl:        SESSION_URL,
          agentName:         config.agentName || 'Website Avatar',
          primaryColor:      config.primaryColor || '#c84b2f',
          debug:             config.debug || false,
          avatar_url:        config.avatar_url || '',
          greetingMessage:   config.greetingMessage || '',
          businessName:      config.businessName || '',
          // accountId from data-account-id attribute — propagated to all session saves
          // so every D1 record is tagged with the client that owns it.
          clientId:          accountId
        };
        const debug = window.WA_CONFIG.debug;

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = BASE_URL + '/widget.css';
        document.head.appendChild(link);

        injectHTML(window.WA_CONFIG.agentName, config);
        injectGreeting(config);

        // ── Core scripts ──
        await Promise.all([
          loadScript(BASE_URL + '/core/state.js'),
          loadScript(BASE_URL + '/core/ai.js'),
          loadScript(BASE_URL + '/core/utils.js')
        ]);

        await Promise.all([
          loadScript(BASE_URL + '/features/actions.js'),
          loadScript(BASE_URL + '/features/bridge.js'),
          loadScript(BASE_URL + '/features/ui.js'),
          loadScript(BASE_URL + '/features/greeting.js')
        ]);

        // ── Discover + agent scripts ──
        await Promise.all([
          loadScript(BASE_URL + '/wa-discover.js'),
          loadScript(BASE_URL + '/wa-agent.js')
        ]);

        await loadScript(BASE_URL + '/wa-elevenlabs.js', true);

        // ── Session sync script ──
        await loadScript(BASE_URL + '/session-sync.js');

        // Initialize greeting after all scripts loaded
        if (window.WebsiteAvatarGreeting) {
          window.WebsiteAvatarGreeting.init();
        }

      } catch(e) {
        console.error('[WA] Failed to load:', e.message);
      }
    }

    // Start by waiting for visitor ID
    waitForVisitorId(initWidget);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();