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

    const agentName     = config.agentName     || 'Website Avatar';
    const businessName  = config.businessName  || '';
    const avatarUrl     = config.avatar_url    || '';
    const greetingMessage = config.greetingMessage ||
      `Hi, I'm ${agentName}${businessName ? ` from ${businessName}` : ''}. I'm an AI trained on everything we do. Can we have a quick chat?`;

    // Up to 3 client-specific bullets from the dedicated greetingBullets config field
    const bullets = (config.greetingBullets || []).slice(0, 3);
    const bulletsHTML = bullets.length ? `
      <div class="wa-greeting-bullets">
        <ul class="wa-greeting-bullets-list">
          ${bullets.map(b => `<li>${b}</li>`).join('')}
        </ul>
      </div>` : '';

    const nameLabel = agentName + (businessName ? ` - ${businessName}` : '') + ' <span>AI</span>';

    // SVG icons — matching widget style (Lucide, stroke-based)
    const iconSpeak = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="14" x2="4" y2="10"/><line x1="8" y1="16" x2="8" y2="8"/><line x1="12" y1="18" x2="12" y2="6"/><line x1="16" y1="16" x2="16" y2="8"/><line x1="20" y1="14" x2="20" y2="10"/></svg>`;
    const iconChat  = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>`;
    const iconClose = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    // If consent not yet given, show the consent block first (two buttons: Accept / Close).
    // Accepting reveals the normal Chat/Speak/Close action buttons beneath.
    // On return visits the consent block is omitted entirely.
    const consentGiven = !!localStorage.getItem('wa_gdpr_consent');

    const actionButtons = `
      <div class="wa-greeting-actions" id="wa-greeting-actions"${consentGiven ? '' : ' style="display:none"'}>
        <button class="wa-greeting-btn wa-greeting-btn--speak" data-action="speak" aria-label="Start voice conversation">
          <span class="wa-greeting-btn-icon">${iconSpeak}</span>
          <span class="wa-greeting-btn-label">Speak</span>
        </button>
        <button class="wa-greeting-btn wa-greeting-btn--chat" data-action="start" aria-label="Start text chat">
          <span class="wa-greeting-btn-icon">${iconChat}</span>
          <span class="wa-greeting-btn-label">Chat</span>
        </button>
        <button class="wa-greeting-btn wa-greeting-btn--close" data-action="close" aria-label="Close">
          <span class="wa-greeting-btn-icon">${iconClose}</span>
          <span class="wa-greeting-btn-label">Close</span>
        </button>
      </div>`;

    const consentBlock = consentGiven ? '' : `
      <div class="wa-greeting-consent-block" id="wa-greeting-consent-block">
        <p class="wa-greeting-consent-text">This chat uses an AI to provide responses. Messages will be stored and processed, and may be used to improve our service. See our <a href="/privacy-policy" target="_blank" rel="noopener" class="wa-consent-link">Privacy Policy</a>.</p>
        <div class="wa-greeting-consent-actions">
          <button class="wa-greeting-consent-accept" data-action="accept-consent" aria-label="Accept">Accept</button>
          <button class="wa-greeting-consent-decline" data-action="close" aria-label="Close">Close</button>
        </div>
      </div>`;

    const greeting = document.createElement('div');
    greeting.id = 'wa-greeting';
    greeting.style.visibility = 'hidden';
    greeting.innerHTML = `
      <div class="wa-greeting-overlay"></div>
      <div class="wa-greeting-container">
        <div class="wa-greeting-bubble">
          <p>${greetingMessage}</p>
        </div>
        <div class="wa-greeting-orb">
          <div class="wa-orb wa-orb-speaking">
            <div class="wa-orb-blob"></div>
            ${avatarUrl ? `<img src="${avatarUrl}" alt="${agentName}" class="wa-orb-avatar" onerror="this.style.display='none'" />` : ''}
          </div>
        </div>
        <div class="wa-greeting-name">${nameLabel}</div>
        <div class="wa-greeting-fade"></div>
        ${consentBlock}
        ${actionButtons}
        ${bulletsHTML}
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
        ? `<img src="${avatarUrl}" alt="Chat" class="wa-bubble-avatar" onerror="this.style.display='none'" />`
        : '💬';
      bubble.onclick = () => window.WebsiteAvatar && WebsiteAvatar.toggleChat();
      document.body.appendChild(bubble);

      // Badge lives outside #wa-bubble so its pulse ring isn't clipped by overflow:hidden
      if (!document.getElementById('wa-badge')) {
        const badge = document.createElement('div');
        badge.id = 'wa-badge';
        badge.className = 'wa-badge';
        document.body.appendChild(badge);
      }
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
            </div>
          </div>
          <div class="wa-header-actions">
            <button class="wa-advice-btn" id="wa-advice-btn" aria-label="How I can help" title="How I can help">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </button>
            <button class="wa-history-btn" id="wa-history-btn" aria-label="View past conversations" title="Past conversations">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>
              </svg>
            </button>
            <button class="wa-fullscreen-btn" id="wa-fullscreen-btn" aria-label="Toggle full screen" title="Toggle full screen">
              <svg id="wa-fullscreen-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="wa-messages" id="wa-messages"></div>
        <div id="wa-orb-panel" class="wa-orb-panel" aria-hidden="true">
          <div id="wa-orb" class="wa-orb wa-orb-idle">
            <div class="wa-orb-blob"></div>
            ${avatarUrl ? `<img src="${avatarUrl}" alt="${name}" class="wa-orb-avatar" onerror="this.style.display='none'" />` : ''}
          </div>
          <div id="wa-voice-status" class="wa-voice-status">Tap to start speaking</div>
        </div>
        <div class="wa-consent-banner" id="wa-consent-banner">
          <p class="wa-consent-text">
            This chat uses an AI to provide responses. Messages will be stored
            and processed, and may be used to improve our service.
            See our <a href="/privacy-policy" target="_blank" rel="noopener" class="wa-consent-link">Privacy Policy</a>.
          </p>
          <button id="wa-consent-btn" class="wa-consent-start-btn">Start Chat</button>
        </div>
        <div id="wa-suggested-prompts" class="wa-suggested-prompts"></div>
        <div class="wa-status-row"><span id="wa-status-label">Offline</span></div>
        <div class="wa-ai-disclaimer" aria-hidden="true">AI can make mistakes. Check important info.</div>
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
          <button id="wa-voice-toggle" aria-label="Switch to voice" title="Voice conversation">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <line x1="4" y1="14" x2="4" y2="10"/><line x1="8" y1="16" x2="8" y2="8"/>
              <line x1="12" y1="18" x2="12" y2="6"/><line x1="16" y1="16" x2="16" y2="8"/>
              <line x1="20" y1="14" x2="20" y2="10"/>
            </svg>
          </button>
          <button id="wa-send" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
            </svg>
          </button>
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

      // Powered-by sits outside the panel so it's not clipped by overflow:hidden
      if (!document.getElementById('wa-poweredby')) {
        const pb = document.createElement('div');
        pb.id = 'wa-poweredby';
        pb.className = 'wa-poweredby';
        pb.setAttribute('aria-hidden', 'true');
        pb.innerHTML = 'Powered by <a title="Powered by Website Avatar" target="_blank" rel="noopener" href="https://www.websiteavatar.co.uk/">Website Avatar</a>';
        document.body.appendChild(pb);
      }

      panel.querySelector('#wa-send').onclick    = () => WebsiteAvatar.sendMessage();
      panel.querySelector('#wa-input').onkeydown = (e) => WebsiteAvatar.handleKey(e);
      panel.querySelector('#wa-history-btn').onclick   = () => WebsiteAvatar.openHistoryPanel?.();
      panel.querySelector('#wa-history-close').onclick = () => WebsiteAvatar.closeHistoryPanel?.();
      panel.querySelector('#wa-history-back').onclick  = () => WebsiteAvatar.closeHistorySession?.();
      panel.querySelector('#wa-advice-btn').onclick    = () => WebsiteAvatar.openAdvicePanel?.();
      panel.querySelector('#wa-advice-close').onclick  = () => WebsiteAvatar.closeAdvicePanel?.();
      panel.querySelector('#wa-fullscreen-btn').onclick  = () => WebsiteAvatar.toggleFullscreen?.();
      panel.querySelector('#wa-voice-toggle').onclick   = () => WebsiteAvatar.toggleVoiceMode?.();

      // ── GDPR CONSENT ──────────────────────────────────────────────────────
      // Check if the user has already consented in a previous session.
      const CONSENT_KEY = 'wa_gdpr_consent';
      const CONSENT_URL = 'https://backend.jacob-e87.workers.dev/consent';

      // _recordConsent — fire-and-forget backend log + localStorage flag.
      // Exposed globally so greeting.js can call it when the user clicks Chat/Speak.
      async function _recordConsent() {
        if (localStorage.getItem(CONSENT_KEY)) return; // already recorded
        const visitorId = localStorage.getItem('wc_visitor') || localStorage.getItem('wa_visitor') || '';
        try {
          const res = await fetch(CONSENT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitor_id: visitorId, consent_given: true, client_id: accountId }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            console.warn('[WA] Consent record failed:', data.error || res.status);
          }
        } catch (e) {
          // Network failure — log locally and continue; do not block the user.
          console.warn('[WA] Consent POST error:', e.message);
        }
        localStorage.setItem(CONSENT_KEY, new Date().toISOString());
      }

      // _applyConsent — clears the widget banner AND the greeting consent block
      // (whichever is still visible). Called from both the widget button and greeting.js.
      function _applyConsent() {
        // Widget banner
        const banner = panel.querySelector('#wa-consent-banner');
        const input  = panel.querySelector('#wa-input');
        const send   = panel.querySelector('#wa-send');
        const mic    = panel.querySelector('#wa-mic');
        if (banner) banner.style.display = 'none';
        if (input)  input.disabled = false;
        if (send)   send.disabled  = false;
        if (mic)    mic.disabled   = false;

        // Greeting consent block — hide it and reveal action buttons if still in DOM
        const greetingBlock   = document.getElementById('wa-greeting-consent-block');
        const greetingActions = document.getElementById('wa-greeting-actions');
        if (greetingBlock)   greetingBlock.style.display   = 'none';
        if (greetingActions) greetingActions.style.display = '';
      }

      // Expose combined record + apply so greeting.js triggers both sides at once.
      window.WA_acceptConsent = async () => {
        await _recordConsent();
        _applyConsent();
      };

      if (localStorage.getItem(CONSENT_KEY)) {
        _applyConsent();
      } else {
        panel.querySelector('#wa-consent-btn').onclick = async () => {
          await _recordConsent();
          _applyConsent();
        };
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
    // Prefers wc_visitor (set by WhatConverts) if available within 5s.
    // Falls back to wa_visitor — a stable UUID we generate and own.
    // Downstream code always reads wa_visitor so it never needs to know the source.
    function waitForVisitorId(callback, attempts = 0) {
      const wcVisitor = localStorage.getItem('wc_visitor');

      if (wcVisitor) {
        localStorage.setItem('wa_visitor', wcVisitor);
        console.log('[WA] ✅ Visitor ID from wc_visitor:', wcVisitor);
        callback();
      } else if (attempts < 50) { // 5 seconds max (50 × 100ms)
        setTimeout(() => waitForVisitorId(callback, attempts + 1), 100);
      } else {
        if (!localStorage.getItem('wa_visitor')) {
          localStorage.setItem('wa_visitor', crypto.randomUUID());
        }
        console.log('[WA] ✅ Visitor ID (generated):', localStorage.getItem('wa_visitor'));
        callback();
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
          primaryColor:      config.primaryColor || '#3C82F6',
          debug:             config.debug        || false,
          avatar_url:        config.avatar_url   || '',
          greetingMessage:   config.greetingMessage || '',
          businessName:      config.businessName || '',
          // accountId from data-account-id attribute — propagated to all session saves
          // so every D1 record is tagged with the client that owns it.
          clientId:          accountId
        };
        const debug = window.WA_CONFIG.debug;

        // Inject brand colour as CSS custom properties.
        // Derives --wa-primary-text (black/white) via WCAG luminance, and
        // --wa-primary-light / --wa-primary-dark via HSL manipulation so the
        // widget has a richer palette without requiring extra config fields.
        document.documentElement.style.setProperty('--wa-primary-colour', window.WA_CONFIG.primaryColor);
        (function () {
          const hex = (window.WA_CONFIG.primaryColor || '#3C82F6').replace('#', '');
          if (!/^[0-9a-fA-F]{6}$/.test(hex)) return; // skip if not a valid 6-digit hex

          const r = parseInt(hex.slice(0,2),16);
          const g = parseInt(hex.slice(2,4),16);
          const b = parseInt(hex.slice(4,6),16);

          // ── WCAG relative luminance → --wa-primary-text ──────────────────
          const toLinear = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
          const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
          document.documentElement.style.setProperty('--wa-primary-text', L > 0.179 ? '#1a1a1a' : '#ffffff');

          // ── RGB → HSL ────────────────────────────────────────────────────
          const rn = r/255, gn = g/255, bn = b/255;
          const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn), d = max - min;
          let h = 0, s = 0;
          const l = (max + min) / 2;
          if (d !== 0) {
            s = d / (1 - Math.abs(2*l - 1));
            h = max === rn ? ((gn-bn)/d + (gn<bn?6:0)) / 6
              : max === gn ? ((bn-rn)/d + 2) / 6
                           : ((rn-gn)/d + 4) / 6;
          }

          // ── Derive palette — boost saturation +10%, shift lightness ─────
          const sPct  = Math.min(1, s + 0.10);                 // +10% saturation
          const lLt   = Math.min(0.92, l + 0.22);             // lighter  (+22%)
          const lDk   = Math.max(0.08, l - 0.18);             // darker   (-18%)

          const hslStr = (hv, sv, lv) => `hsl(${Math.round(hv*360)},${Math.round(sv*100)}%,${Math.round(lv*100)}%)`;
          document.documentElement.style.setProperty('--wa-primary-light', hslStr(h, sPct, lLt));
          document.documentElement.style.setProperty('--wa-primary-dark',  hslStr(h, sPct, lDk));
        })();

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
            // Header row with toggle
            const header = document.createElement('div');
            header.className = 'wa-prompts-header';
            header.innerHTML = '<span class="wa-prompts-label">Suggestions</span>'
              + '<button class="wa-prompts-toggle" aria-label="Toggle suggestions" title="Toggle suggestions">'
              + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
              + '</button>';
            container.appendChild(header);

            // Chips wrapper
            const chipsEl = document.createElement('div');
            chipsEl.className = 'wa-prompts-chips';
            prompts.forEach(text => {
              const chip = document.createElement('button');
              chip.className = 'wa-prompt-chip';
              chip.textContent = text;
              chip.onclick = () => {
                const input = document.getElementById('wa-input');
                if (input) { input.value = text; input.focus(); }
                container.style.display = 'none';
              };
              chipsEl.appendChild(chip);
            });
            container.appendChild(chipsEl);

            // Toggle expand / collapse
            header.querySelector('.wa-prompts-toggle').addEventListener('click', () => {
              container.classList.toggle('wa-prompts-collapsed');
            });

            // Click-drag to scroll for mouse users
            let isDragging = false, startX = 0, scrollLeft = 0;
            chipsEl.addEventListener('mousedown', e => {
              isDragging = true;
              startX = e.pageX - chipsEl.offsetLeft;
              scrollLeft = chipsEl.scrollLeft;
              chipsEl.style.cursor = 'grabbing';
            });
            chipsEl.addEventListener('mouseleave', () => { isDragging = false; chipsEl.style.cursor = ''; });
            chipsEl.addEventListener('mouseup',    () => { isDragging = false; chipsEl.style.cursor = ''; });
            chipsEl.addEventListener('mousemove',  e => {
              if (!isDragging) return;
              e.preventDefault();
              chipsEl.scrollLeft = scrollLeft - (e.pageX - chipsEl.offsetLeft - startX);
            });
          }
        }

        // Hide voice toggle if no voiceAgentId is configured
        if (!window.WA_CONFIG.voiceAgentId) {
          const voiceBtn = document.getElementById('wa-voice-toggle');
          if (voiceBtn) voiceBtn.style.display = 'none';
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

        // ── Ecommerce (config-driven) ──
        // Must load BEFORE wa-agent.js so ecom actions are registered in
        // WA.ActionRegistry before auto-connect fires and buildClientTools() runs.
        const _cfg = window.WA_CONFIG || {};
        if (_cfg.ecomEnabled && _cfg.ecomPlatform) {
          await loadScript(BASE_URL + '/features/ecom/index.js');
          await loadScript(BASE_URL + `/features/ecom/providers/${_cfg.ecomPlatform}.js`);
        }

        // ── Discover + agent scripts ──
        await Promise.all([
          loadScript(BASE_URL + '/wa-discover.js'),
          loadScript(BASE_URL + '/wa-agent.js')
        ]);

        await loadScript(BASE_URL + '/wa-dialogue.js', true);

        // ── Session sync script ──
        await loadScript(BASE_URL + '/session-sync.js');

        // ── Re-engagement (inactivity + exit intent) ──
        await loadScript(BASE_URL + '/features/re-engagement.js');

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