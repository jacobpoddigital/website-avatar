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
        </div>
        <div class="wa-messages" id="wa-messages"></div>
        <div class="wa-input-row">
          <input type="text" id="wa-input" placeholder="Type a message…" />
          <button id="wa-send">Send</button>
        </div>
      `;
      document.body.appendChild(panel);

      panel.querySelector('#wa-send').onclick  = () => WebsiteAvatar.sendMessage();
      panel.querySelector('#wa-input').onkeydown = (e) => WebsiteAvatar.handleKey(e);
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
          businessName:      config.businessName || ''
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

        if (debug) console.log('[WA] Website Avatar loaded from', BASE_URL, '| account:', accountId);

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