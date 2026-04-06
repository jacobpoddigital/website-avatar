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
      `Hi, I'm ${agentName}${config.businessName ? ` from ${config.businessName}` : ''}. I'm an AI trained on everything we do. Can we have a quick chat?`;

    const greeting = document.createElement('div');
    greeting.id = 'wa-greeting';
    greeting.style.visibility = 'hidden';
    greeting.innerHTML = `
      <div class="wa-greeting-overlay"></div>
      <div class="wa-greeting-container">
        <button class="wa-greeting-close" data-action="close" aria-label="Close">
          ✕
        </button>
        ${avatarUrl ? `<img src="${avatarUrl}" alt="${agentName}" class="wa-greeting-avatar" onerror="this.style.display='none'" />` : ''}
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
      overlay.style.visibility = 'hidden';
      overlay.innerHTML = '<div class="wa-nav-label"></div>';
      document.body.appendChild(overlay);
    }

    if (!document.getElementById('wa-bubble')) {
      const bubble = document.createElement('button');
      bubble.id = 'wa-bubble';
      bubble.style.visibility = 'hidden';
      bubble.innerHTML = avatarUrl
        ? `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" onerror="this.style.display='none'" /><div class="wa-badge" id="wa-badge"></div>`
        : '💬<div class="wa-badge" id="wa-badge"></div>';
      bubble.onclick = () => window.WebsiteAvatar && WebsiteAvatar.toggleChat();
      document.body.appendChild(bubble);
    }

    if (!document.getElementById('wa-panel')) {
      const panel = document.createElement('div');
      panel.id = 'wa-panel';
      panel.style.visibility = 'hidden';
      const avatarHtml = avatarUrl ? `<div class="wa-avatar-ring"><img src="${avatarUrl}" alt="${name}" class="wa-header-avatar" onerror="this.style.display='none'" /></div>` : '';
      panel.innerHTML = `
        <div class="wa-header">
          <div class="wa-header-info">
            ${avatarHtml}
            <div>
              <h4>${name}</h4>
              <span id="wa-status-label">Offline</span>
            </div>
          </div>
          <div class="wa-header-actions">
            <button class="wa-advice-btn" id="wa-advice-btn" aria-label="How I can help" title="How I can help">?</button>
            <button class="wa-history-btn" id="wa-history-btn" aria-label="View past conversations" title="Past conversations">•••</button>
            <button class="wa-fullscreen-btn" id="wa-fullscreen-btn" aria-label="Toggle full screen" title="Toggle full screen">
              <svg id="wa-fullscreen-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
                <path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
              </svg>
            </button>
          </div>
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
        <div id="wa-suggested-prompts" class="wa-suggested-prompts"></div>
        <div class="wa-input-row">
          <input type="text" id="wa-input" placeholder="Type a message…" disabled />
          <canvas id="wa-mic-wave" aria-hidden="true"></canvas>
          <button id="wa-mic" disabled aria-label="Voice input" title="Voice input">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </button>
          <button id="wa-send" disabled>Send</button>
        </div>
        <div class="wa-history-panel" id="wa-history-panel" aria-hidden="true">
          <div class="wa-history-header">
            <span class="wa-history-title">Past Conversations</span>
            <button class="wa-history-close" id="wa-history-close" aria-label="Close">✕</button>
          </div>
          <div class="wa-history-list" id="wa-history-list"></div>
          <div class="wa-history-auth" id="wa-history-auth"></div>
        </div>
        <div class="wa-history-view" id="wa-history-view" aria-hidden="true">
          <div class="wa-history-view-header">
            <button class="wa-history-back" id="wa-history-back" aria-label="Back to list">← Back</button>
            <span class="wa-history-view-date" id="wa-history-view-date"></span>
          </div>
          <div class="wa-history-view-msgs" id="wa-history-view-msgs"></div>
        </div>
        <div class="wa-advice-panel" id="wa-advice-panel" aria-hidden="true">
          <div class="wa-advice-header">
            <span class="wa-advice-title">How I Can Help</span>
            <button class="wa-advice-close" id="wa-advice-close" aria-label="Close">✕</button>
          </div>
          <div class="wa-advice-body">
            <div class="wa-advice-section">
              <div>
                <div class="wa-advice-label">Ask Anything</div>
                <p class="wa-advice-text">Type a question or ask me to highlight a specific section of this page. I'll point you to exactly what you need.</p>
              </div>
            </div>
            <div class="wa-advice-section">
              <div>
                <div class="wa-advice-label">Guided Navigation</div>
                <p class="wa-advice-text">I can take you to the right page or scroll to the relevant section automatically — no searching required.</p>
              </div>
            </div>
            <div class="wa-advice-section">
              <div>
                <div class="wa-advice-label">Product Guidance</div>
                <p class="wa-advice-text">Tell me what you're looking for and I'll help you find the right product or option, even if you're not sure where to start.</p>
              </div>
            </div>
            <div class="wa-advice-section">
              <div>
                <div class="wa-advice-label">Forms &amp; Checkout</div>
                <p class="wa-advice-text">I can walk you through forms, answer questions at checkout, and help you complete your purchase without friction.</p>
              </div>
            </div>
            <div class="wa-advice-section">
              <div>
                <div class="wa-advice-label">Session Memory</div>
                <p class="wa-advice-text">Your conversation is remembered across visits. Pick up where you left off without repeating yourself.</p>
              </div>
            </div>
            <div class="wa-advice-section">
              <div>
                <div class="wa-advice-label">Sign In for Personalised Help</div>
                <p class="wa-advice-text">Enter your email to be remembered. You'll get personalised advice, your full conversation history, and smarter guidance tailored to your intent.</p>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      panel.querySelector('#wa-send').onclick    = () => WebsiteAvatar.sendMessage();
      panel.querySelector('#wa-input').onkeydown = (e) => WebsiteAvatar.handleKey(e);
      panel.querySelector('#wa-history-btn').onclick   = () => WebsiteAvatar.openHistoryPanel?.();
      panel.querySelector('#wa-history-close').onclick = () => WebsiteAvatar.closeHistoryPanel?.();
      panel.querySelector('#wa-history-back').onclick  = () => WebsiteAvatar.closeHistorySession?.();
      panel.querySelector('#wa-advice-btn').onclick    = () => WebsiteAvatar.openAdvicePanel?.();
      panel.querySelector('#wa-advice-close').onclick  = () => WebsiteAvatar.closeAdvicePanel?.();
      panel.querySelector('#wa-fullscreen-btn').onclick = () => WebsiteAvatar.toggleFullscreen?.();

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
              body: JSON.stringify({ visitor_id: visitorId, consent_given: true, client_id: accountId }),
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
        const mic    = panel.querySelector('#wa-mic');
        if (banner) banner.style.display = 'none';
        if (input)  input.disabled = false;
        if (send)   send.disabled  = false;
        if (mic)    mic.disabled   = false;
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
        console.warn('[WA] ⚠️ Visitor ID not found after 5s — widget not loaded');
      }
    }

    function initWidget() {
      loadWidgetScripts();
    }

    async function loadWidgetScripts() {
      // Gate: localStorage must be accessible. If it's blocked (Safari strict privacy,
      // locked-down corporate environments) the widget cannot maintain sessions and
      // should not load at all — better nothing than a broken, stateless experience.
      try {
        localStorage.setItem('wa_storage_check', '1');
        localStorage.removeItem('wa_storage_check');
      } catch (e) {
        console.warn('[WA] localStorage unavailable — widget not loaded');
        return;
      }

      try {
        let config = {};
        if (accountId) {
          try {
            const res = await fetch(`${CONFIG_URL}?id=${accountId}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) config = await res.json();
            else console.warn('[WA] Config not found for account:', accountId);
          } catch(e) {
            console.warn('[WA] Could not fetch config:', e.message);
          }
        } else {
          console.warn('[WA] No data-account-id provided on script tag');
        }

        window.WA_CONFIG = {
          // Spread full KV config so any new fields (loadingStyle, suggestedPrompts, etc.)
          // flow through automatically without needing to be listed here explicitly
          ...config,
          // Override or inject fields that need defaults or aren't in KV
          openaiProxyUrl:    PROXY_URL,
          sessionUrl:        SESSION_URL,
          agentName:         config.agentName    || 'Website Avatar',
          primaryColor:      config.primaryColor || '#c84b2f',
          debug:             config.debug        || false,
          avatar_url:        config.avatar_url   || '',
          greetingMessage:   config.greetingMessage || '',
          businessName:      config.businessName || '',
          // accountId from data-account-id attribute — propagated to all session saves
          // so every D1 record is tagged with the client that owns it.
          clientId:          accountId
        };
        const debug = window.WA_CONFIG.debug;

        // Inject brand colour as a CSS custom property so widget styles can reference it
        document.documentElement.style.setProperty('--wa-primary-colour', window.WA_CONFIG.primaryColor);

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = BASE_URL + '/widget.css';
        link.addEventListener('load', () => {
          ['wa-bubble', 'wa-panel', 'wa-transition', 'wa-greeting'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.visibility = '';
          });
        });
        document.head.appendChild(link);

        injectHTML(window.WA_CONFIG.agentName, config);
        injectGreeting(config);

        // Render suggested prompt chips if configured — falls back to nothing if absent
        const prompts = window.WA_CONFIG.suggestedPrompts;
        if (Array.isArray(prompts) && prompts.length) {
          const container = document.getElementById('wa-suggested-prompts');
          if (container) {
            prompts.forEach(text => {
              const chip = document.createElement('button');
              chip.className = 'wa-prompt-chip';
              chip.textContent = text;
              chip.onclick = () => {
                const input = document.getElementById('wa-input');
                if (input) { input.value = text; input.focus(); }
                container.style.display = 'none';
              };
              container.appendChild(chip);
            });
          }
        }

        // ── Core scripts ──
        await Promise.all([
          loadScript(BASE_URL + '/core/state.js'),
          loadScript(BASE_URL + '/core/ai.js'),
          loadScript(BASE_URL + '/core/utils.js'),
          loadScript(BASE_URL + '/core/auth.js')   // must load before session-sync.js
        ]);

        await Promise.all([
          loadScript(BASE_URL + '/features/actions.js'),
          loadScript(BASE_URL + '/features/bridge.js'),
          loadScript(BASE_URL + '/features/ui.js'),
          loadScript(BASE_URL + '/features/greeting.js'),
          loadScript(BASE_URL + '/features/mic.js')
        ]);

        // ── Discover + agent scripts ──
        await Promise.all([
          loadScript(BASE_URL + '/wa-discover.js'),
          loadScript(BASE_URL + '/wa-agent.js')
        ]);

        await loadScript(BASE_URL + '/wa-dialogue.js', true);

        // ── Session sync script ──
        await loadScript(BASE_URL + '/session-sync.js');

        // Initialize greeting after all scripts loaded
        if (window.WebsiteAvatarGreeting) {
          window.WebsiteAvatarGreeting.init();
        }

      } catch(e) {
        console.error('[WA] Failed to load:', e.message);
        // Remove injected elements — a partially loaded widget is worse than no widget
        ['wa-bubble', 'wa-panel', 'wa-transition', 'wa-greeting'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
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