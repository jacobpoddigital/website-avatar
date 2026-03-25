/**
 * wa-elevenlabs.js — ElevenLabs bridge (text-only / chat mode)
 * Uses @elevenlabs/client SDK via esm.sh CDN
 * Connects to ElevenLabs conversational agent in text-only mode.
 * No audio, no microphone.
 *
 * IMPORTANT: In ElevenLabs dashboard → agent Security tab,
 * ensure "Allow conversation config overrides" is enabled.
 */

import { Conversation } from 'https://esm.sh/@elevenlabs/client@0.14.0';

(function () {

  const WA    = window.WA    || (window.WA = {});
  const DEBUG = (window.WA_CONFIG || {}).debug || false;

  function log  (...a) { if (DEBUG) console.log ('[WA:Bridge]', ...a); }
  function warn (...a) {           console.warn('[WA:Bridge]', ...a); }

  if (!Conversation) {
    warn('Failed to import Conversation from @elevenlabs/client');
    return;
  }

  const CONFIG   = window.WA_CONFIG || {};
  const AGENT_ID = CONFIG.elevenlabsAgentId || '';

  let session = null;

  // ─── CONTEXT BUILDERS ─────────────────────────────────────────────────────

  function buildPageContext() {
    const pages = WA.PAGE_MAP || [];
    const forms = WA.FORM_MAP || [];
    const lines = [
      `CURRENT PAGE: ${document.title} (${window.location.href})`,
      `AVAILABLE PAGES (${pages.length}):`,
      ...pages.map(p => `  - ${p.label}: ${p.file}`),
    ];
    if (forms.length) {
      lines.push(`CONTACT FORM FIELDS:`);
      forms[0]?.fields?.forEach(f => {
        lines.push(`  - ${f.label}${f.required ? ' *' : ''} (${f.name})`);
      });
    }
    return lines.join('\n');
  }

  function buildReconnectContext() {
    const s = (() => {
      try { return JSON.parse(sessionStorage.getItem('wa_session') || '{}'); } catch { return {}; }
    })();
    if (!s.messages?.length) return null;

    const lines = ['SESSION CONTEXT:'];
    const recent = s.messages.slice(-8);
    lines.push('RECENT CONVERSATION:');
    recent.forEach(m => lines.push(`  ${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`));
    lines.push('');

    const completedForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'complete');
    const deniedForm = (() => {
      const d = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'denied');
      if (!d) return null;
      const navigatedAfter = (s.actions || []).some(
        a => a.type === 'navigate' && a.status === 'complete' &&
             (a.completedAt || 0) > (d.completedAt || 0)
      );
      return navigatedAfter ? null : d;
    })();

    if (completedForm) {
      const fields = completedForm.payload.fields.filter(f => f.value);
      if (fields.length) {
        lines.push('USER DETAILS COLLECTED:');
        fields.forEach(f => lines.push(`  ${f.label}: ${f.value}`));
        lines.push('');
      }
      lines.push('OUTCOME: Contact form submitted successfully.');
    } else if (deniedForm) {
      lines.push('OUTCOME: User did not complete the contact form.');
    }

    return lines.join('\n');
  }

  function buildReconnectPrompt() {
    const s = (() => {
      try { return JSON.parse(sessionStorage.getItem('wa_session') || '{}'); } catch { return {}; }
    })();
    if (!s.messages?.length) return null;

    const sentKey = 'wa_sent_prompts';
    const sent = (() => {
      try { return new Set(JSON.parse(sessionStorage.getItem(sentKey) || '[]')); } catch { return new Set(); }
    })();

    const completedForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'complete');
    if (completedForm && !sent.has(completedForm.id)) {
      sent.add(completedForm.id);
      sessionStorage.setItem(sentKey, JSON.stringify([...sent]));
      const fields = completedForm.payload.fields.filter(f => f.value);
      return `[SYSTEM: The contact form was just submitted with: ${fields.map(f => `${f.label}=${f.value}`).join(', ')}. Acknowledge this naturally and ask if there's anything else you can help with.]`;
    }

    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg?.role === 'user') {
      const key = `user_${lastMsg.ts}`;
      if (!sent.has(key)) {
        sent.add(key);
        sessionStorage.setItem(sentKey, JSON.stringify([...sent]));
        return `[SYSTEM: The user's last message was: "${lastMsg.text}". Continue the conversation naturally from here.]`;
      }
    }
    return null;
  }

  // ─── CONNECTION ───────────────────────────────────────────────────────────

  async function connect() {
    if (session) { await disconnect(); return; }

    if (!AGENT_ID) {
      warn('No agent ID — check backend KV config');
      return;
    }

    const btn = document.getElementById('wa-connect-btn');
    if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }

    if (typeof WA.onBridgeConnecting === 'function') WA.onBridgeConnecting();

    const reconnectCtx  = buildReconnectContext();
    const pageCtx       = buildPageContext();
    const contextToSend = reconnectCtx ? `${pageCtx}\n\n${reconnectCtx}` : pageCtx;

    try {
      session = await Conversation.startSession({
        agentId: AGENT_ID,

        // Text-only / chat mode — no audio, no mic
        overrides: {
          conversation: { textOnly: true }
        },

        // Inject page + session context as dynamic variable
        dynamicVariables: contextToSend ? { context: contextToSend } : undefined,

        onConnect: () => {
          log('Connected');
          setConnectUI(true);

          // Open panel directly — do NOT call toggleChat (causes reconnect loop)
          const panel = document.getElementById('wa-panel');
          if (panel && !panel.classList.contains('wa-open')) {
            panel.classList.add('wa-open');
            const badge = document.getElementById('wa-badge');
            if (badge) badge.classList.remove('wa-show');
            if (typeof WA._openPanelDirect === 'function') WA._openPanelDirect();
          }

          // Send reconnect prompt after session settles
          setTimeout(() => {
            if (session?.sendUserMessage) {
              const prompt = buildReconnectPrompt();
              if (prompt) { log('Reconnect prompt sent'); session.sendUserMessage(prompt); }
            }
          }, 400);

          if (typeof WA.onBridgeConnected === 'function') WA.onBridgeConnected();
        },

        onDisconnect: () => {
          log('Disconnected');
          session = null;
          setConnectUI(false);
          if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
        },

        onMessage: (msg) => {
          if (!msg.message) return;

          if (msg.source === 'ai') {
            // In text-only mode, only handle final messages
            if (msg.isFinal === false) return;
            const clean = msg.message.replace(/\[[^\]]+\]\s*/g, '').trim();
            if (!clean) return;
            log(`Agent: "${clean.slice(0, 80)}"`);
            if (typeof WA.onAgentMessage === 'function') WA.onAgentMessage(clean);
            WA.inactivity?.tick();
          }

          if (msg.source === 'user') {
            if (msg.isFinal === false) return;
            const text = msg.message.trim();
            if (text && text !== '...' && text !== '…') {
              if (typeof WA.onUserMessage === 'function') WA.onUserMessage(text);
            }
          }
        },

        onError: (err) => {
          warn('Error:', err);
          if (typeof WA.agentSay === 'function') {
            WA.agentSay('Something went wrong. Please try reconnecting.');
          }
          setConnectUI(false);
          if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
        },

        onStatusChange: (info) => {
          log('Status:', info.status);
        }
      });

    } catch (err) {
      warn('Connection failed:', err.message);
      if (typeof WA.agentSay === 'function') {
        WA.agentSay('Could not connect. Please check your connection and try again.');
      }
      if (btn) { btn.textContent = 'Connect'; btn.disabled = false; }
      if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
    }
  }

  async function disconnect() {
    if (!session) return;
    try { await session.endSession(); } catch(e) {}
    session = null;
    setConnectUI(false);
  }

  function sendText(text) {
    if (!session) return false;
    try {
      session.sendUserMessage(text);
      return true;
    } catch(e) {
      warn('sendText error:', e.message);
      return false;
    }
  }

  function isConnected() { return !!session; }

  // ─── UI ───────────────────────────────────────────────────────────────────

  function setConnectUI(connected) {
    const btn   = document.getElementById('wa-connect-btn');
    const label = document.getElementById('wa-status-label');
    if (btn) {
      btn.textContent = connected ? 'Disconnect' : 'Connect';
      btn.disabled    = false;
    }
    if (label) label.textContent = connected ? 'Connected' : 'Offline';
  }

  // ─── EXPOSE BRIDGE ────────────────────────────────────────────────────────

  WA.bridge = { connect, disconnect, sendText, isConnected };

  if (WA.bus) {
    WA.bus.emit('bridge:ready');
    log('Bridge ready');
  } else {
    warn('WA.bus not available — wa-agent.js may not have loaded');
  }

})();