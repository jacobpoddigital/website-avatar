/**
 * wa-elevenlabs.js — Website Avatar by AdVelocity
 * 11labs bridge. Single responsibility: manage the 11labs connection
 * and emit clean events to wa-agent.js via WA.on* callbacks.
 * No DOM manipulation. No session access. No classification.
 */

import { Conversation } from 'https://cdn.skypack.dev/@elevenlabs/client';

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  const WA = window.WebsiteAvatar;

  const CONFIG   = window.WA_CONFIG || {};
  const AGENT_ID = CONFIG.elevenlabsAgentId || 'agent_5301km0zvkdqf208d3k4kzfyafjx';
  const DEBUG    = CONFIG.debug || false;

  function log(...args)  { if (DEBUG) console.log('[WA:Bridge]', ...args); }
  function warn(...args) { console.warn('[WA:Bridge]', ...args); }

  // ─── STATE ────────────────────────────────────────────────────────────────

  let session      = null; // 11labs Conversation session
  let isVoiceMode  = false;
  let animFrame    = null;
  let speakStart   = null; // timestamp when agent started speaking

  // ─── WEBSOCKET INTERCEPT ──────────────────────────────────────────────────
  // Patches native WebSocket to intercept agent_response_event.
  // This fires during audio playback — shows text as early as possible.

  (function patchWebSocket() {
    const Original = window.WebSocket;

    window.WebSocket = function (url, protocols) {
      const ws = protocols ? new Original(url, protocols) : new Original(url);
      if (!url.includes('convai') && !url.includes('elevenlabs')) return ws;

      log('WebSocket patched');

      const origAddListener = ws.addEventListener.bind(ws);
      ws.addEventListener = function (type, listener, options) {
        if (type !== 'message') return origAddListener(type, listener, options);

        return origAddListener(type, function (event) {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'agent_response' && data.agent_response_event?.agent_response) {
              const text  = data.agent_response_event.agent_response;
              const clean = text.replace(/\[[^\]]+\]\s*/g, '').trim();
              const ms    = speakStart ? Date.now() - speakStart : null;
              log(`Pre-audio text (${ms !== null ? ms + 'ms' : '?ms'}): "${clean.slice(0, 60)}"`);
              if (typeof WA.onPreAudioMessage === 'function') WA.onPreAudioMessage(clean);
            }
          } catch (e) { /* not JSON */ }
          listener(event);
        }, options);
      };

      return ws;
    };

    Object.keys(Original).forEach(k => { try { window.WebSocket[k] = Original[k]; } catch(e) {} });
    window.WebSocket.prototype = Original.prototype;
  })();

  // ─── CONTEXT BUILDERS ─────────────────────────────────────────────────────

  function buildPageContext() {
    const s       = WA.getSession ? WA.getSession() : null;
    const pageMap = WA.PAGE_MAP || [];
    const lines   = ['=== SESSION CONTEXT ==='];

    lines.push(`Current page: ${window.location.href}`);

    const current = pageMap.find(p => p.file.replace(/\/$/, '') === window.location.href.replace(/\/$/, ''));
    if (current) lines.push(`Page name: ${current.label}`);

    if (pageMap.length) {
      lines.push('\nAvailable pages:');
      pageMap.forEach(p => lines.push(`- ${p.label}: ${p.file}`));
    }

    // Known user details
    if (s) {
      const completedForm = s.actions.find(a => a.type === 'fill_form' && a.status === 'complete');
      if (completedForm) {
        const fields = completedForm.payload.fields.filter(f => f.value);
        if (fields.length) {
          lines.push('\nKnown user details:');
          fields.forEach(f => lines.push(`- ${f.label}: ${f.value}`));
        }
      }
    }

    lines.push('=== END CONTEXT ===');
    return lines.join('\n');
  }

  function buildReconnectContext() {
    const s = WA.getSession ? WA.getSession() : null;
    if (!s || (!s.messages.length && !s.actions.length)) return null;

    const lines = ['=== HANDOVER CONTEXT ==='];
    lines.push('You were briefly disconnected while the user interacted with the page.');
    lines.push('');

    const completedForm = s.actions.find(a => a.type === 'fill_form' && a.status === 'complete');
    const deniedForm    = s.actions.find(a => a.type === 'fill_form' && a.status === 'denied');

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

    const actions = s.actions.filter(a => ['navigate','fill_form','navigate_then_fill'].includes(a.type));
    if (actions.length) {
      lines.push('\nACTIONS TAKEN:');
      actions.forEach(a => {
        const age = a.completedAt ? `${Math.round((Date.now() - a.completedAt) / 1000)}s ago` : 'ongoing';
        lines.push(`  ${a.type}: ${a.status} (${age})`);
      });
    }

    const recent = s.messages.slice(-10);
    if (recent.length) {
      lines.push('\nRECENT CONVERSATION:');
      recent.forEach(m => lines.push(`  ${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`));
    }

    lines.push('\nINSTRUCTIONS:');
    lines.push('- Do not re-introduce yourself');
    lines.push('- Use the user\'s name if you have it');
    lines.push('- Pick up naturally as if you were present the whole time');
    lines.push('=== END HANDOVER ===');

    return lines.join('\n');
  }

  function buildReconnectPrompt() {
    const s = WA.getSession ? WA.getSession() : null;
    if (!s) return null;

    const sentPrompts = WA._sentReconnectPrompts || new Set();

    // Form submitted
    const completedForm = s.actions.find(a => a.type === 'fill_form' && a.status === 'complete');
    if (completedForm && !sentPrompts.has(completedForm.id)) {
      sentPrompts.add(completedForm.id);
      WA._sentReconnectPrompts = sentPrompts;
      const nameField = completedForm.payload.fields.find(f =>
        f.label.toLowerCase().includes('name') && !f.label.toLowerCase().includes('company')
      );
      const name = nameField ? nameField.value : null;
      return name
        ? `The contact form was just submitted by ${name}. Acknowledge warmly, use their name, ask if there is anything else you can help with.`
        : `The contact form was just submitted. Acknowledge warmly and ask if there is anything else you can help with.`;
    }

    // Form denied
    const deniedForm = s.actions.find(a => a.type === 'fill_form' && a.status === 'denied');
    if (deniedForm && !sentPrompts.has(deniedForm.id)) {
      sentPrompts.add(deniedForm.id);
      WA._sentReconnectPrompts = sentPrompts;
      return `The user decided not to submit the contact form. Let them know they can come back to it and ask how else you can help.`;
    }

    // Recent navigation
    const recentNav = s.actions
      .filter(a => a.type === 'navigate' && a.status === 'complete')
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0];
    if (recentNav && !sentPrompts.has(recentNav.id)) {
      sentPrompts.add(recentNav.id);
      WA._sentReconnectPrompts = sentPrompts;
      const page = recentNav.payload.targetLabel || 'this page';
      return `You just navigated the user to the ${page}. Briefly acknowledge the arrival and ask what they'd like to do here.`;
    }

    return null;
  }

  // ─── VOLUME ANIMATION ─────────────────────────────────────────────────────

  function startVolumeAnim() {
    const analyser = session?.output?.analyser;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteFrequencyData(data);
      const vol   = data.reduce((a, b) => a + b, 0) / data.length;
      const scale = 1 + (vol / 400);
      const ring  = document.getElementById('wa-avatar-ring');
      if (ring) ring.style.transform = `scale(${scale})`;
      animFrame = requestAnimationFrame(tick);
    }
    tick();
  }

  function stopVolumeAnim() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    const ring = document.getElementById('wa-avatar-ring');
    if (ring) ring.style.transform = 'scale(1)';
  }

  // ─── UI HELPERS ───────────────────────────────────────────────────────────

  function setConnectUI(connected) {
    const btn   = document.getElementById('wa-connect-btn');
    const label = document.getElementById('wa-status-label');
    if (btn) {
      btn.textContent = connected ? 'Disconnect' : 'Connect';
      btn.classList.toggle('wa-connected', connected);
      btn.disabled = false;
    }
    if (label) {
      label.textContent = connected
        ? (isVoiceMode ? 'Listening…' : 'Connected')
        : 'Offline';
    }
  }

  function setSpeakingUI(speaking) {
    const avatar = document.getElementById('wa-avatar');
    const label  = document.getElementById('wa-status-label');
    if (avatar) avatar.classList.toggle('wa-speaking', speaking);
    if (label && session) {
      label.textContent = speaking ? 'Speaking…' : (isVoiceMode ? 'Listening…' : 'Connected');
    }
    if (speaking) { speakStart = Date.now(); startVolumeAnim(); }
    else          { stopVolumeAnim(); }

    // Notify agent
    if (speaking && typeof WA.onSpeakingStart === 'function') WA.onSpeakingStart();
    if (!speaking && typeof WA.onSpeakingStop === 'function') WA.onSpeakingStop();
  }

  // ─── CONNECTION ───────────────────────────────────────────────────────────

  async function connect(contextOverride) {
    if (session) { await disconnect(); return; }

    const btn = document.getElementById('wa-connect-btn');
    if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }

    // Build context — always include page, merge with reconnect if available
    const reconnectCtx = contextOverride || buildReconnectContext();
    const pageCtx      = buildPageContext();
    const contextToSend = reconnectCtx ? `${pageCtx}\n\n${reconnectCtx}` : pageCtx;

    const sessionConfig = { agentId: AGENT_ID };
    if (contextToSend) sessionConfig.dynamicVariables = { context: contextToSend };

    try {
      session = await Conversation.startSession({
        ...sessionConfig,

        onConnect: () => {
          log('Connected');
          setConnectUI(true);

          if (!isVoiceMode) {
            setTimeout(() => { if (session?.setMicMuted) session.setMicMuted(true); }, 300);
          }

          // Open panel
          const panel = document.getElementById('wa-panel');
          if (panel && !panel.classList.contains('wa-open')) {
            if (typeof WA.toggleChat === 'function') WA.toggleChat();
          }

          // Inject context then reconnect prompt
          setTimeout(() => {
            if (session?.sendContextualUpdate) {
              session.sendContextualUpdate(contextToSend);
              log('Context injected');
            }
          }, 500);

          setTimeout(() => {
            if (session?.sendUserMessage) {
              const prompt = buildReconnectPrompt();
              if (prompt) { log('Reconnect prompt sent'); session.sendUserMessage(prompt); }
            }
          }, 900);

          if (typeof WA.onBridgeConnected === 'function') WA.onBridgeConnected();
        },

        onDisconnect: () => {
          log('Disconnected');
          session = null;
          setConnectUI(false);
          setSpeakingUI(false);
          if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
        },

        onMessage: (msg) => {
          if (!msg.message) return;

          if (msg.source === 'ai') {
            const clean = msg.message.replace(/\[[^\]]+\]\s*/g, '').trim();

            if (msg.isFinal === false) {
              // Tentative — show immediately if no pre-audio message already showing
              if (!window._wa_tentativeCommitted && typeof WA.showTentativeMessage === 'function') {
                WA.showTentativeMessage(clean);
              }
              return;
            }

            // Final transcript
            const ms = speakStart ? Date.now() - speakStart : null;
            log(`Final transcript (${ms !== null ? ms + 'ms' : '?ms'}): "${clean.slice(0, 60)}"`);

            // Commit any tentative bubble
            if (typeof WA.commitTentativeMessage === 'function') {
              WA.commitTentativeMessage(clean);
            }

            // Notify agent — agentSay + classification
            if (typeof WA.onAgentMessage === 'function') WA.onAgentMessage(clean);

            WA.inactivity?.tick();
          }

          if (msg.source === 'user') {
            if (msg.isFinal === false) return;
            const text   = msg.message.trim();
            const isReal = text && text !== '...' && text !== '…';
            if (isReal) {
              if (typeof WA.onUserMessage === 'function') WA.onUserMessage(text);
            }
          }
        },

        onModeChange: (mode) => {
          setSpeakingUI(mode.mode === 'speaking');
        },

        onError: (err) => {
          warn('Error:', err);
          if (typeof WA.agentSay === 'function') {
            WA.agentSay('Something went wrong. Please try reconnecting.');
          }
          setConnectUI(false);
        },

        onStatusChange: (info) => {
          if (info.status === 'disconnected') {
            session = null;
            setConnectUI(false);
            setSpeakingUI(false);
            if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
          }
        }
      });

    } catch (err) {
      warn('Connection failed:', err);
      const micErr = err.message?.includes('microphone') || err.message?.includes('permission');
      if (typeof WA.agentSay === 'function') {
        WA.agentSay(micErr
          ? 'Microphone access was denied. Please allow mic access or use text mode.'
          : 'Could not connect. Please check your connection and try again.'
        );
      }
      if (btn) { btn.textContent = 'Connect'; btn.disabled = false; }
    }
  }

  async function disconnect() {
    if (!session) return;
    try { await session.endSession(); } catch(e) {}
    session = null;
    setConnectUI(false);
    setSpeakingUI(false);
  }

  function sendText(text) {
    if (!session) return false;
    session.sendUserMessage(text);
    if (session.sendUserActivity) session.sendUserActivity();
    WA.inactivity?.reset();
    return true;
  }

  function isConnected() { return !!session; }

  function toggleMic() {
    isVoiceMode = !isVoiceMode;
    const btn   = document.getElementById('wa-mic-btn');
    if (btn) btn.classList.toggle('wa-active', isVoiceMode);
    if (session?.setMicMuted) session.setMicMuted(!isVoiceMode);
    const label = document.getElementById('wa-status-label');
    if (label && session) label.textContent = isVoiceMode ? 'Listening…' : 'Connected';
  }

  function sendPageContext() {
    if (!session?.sendContextualUpdate) return;
    session.sendContextualUpdate(buildPageContext());
    log('Page context updated');
  }

  // ─── EXPOSE BRIDGE ────────────────────────────────────────────────────────
  // wa-agent.js uses WA.bridge.connect(), WA.bridge.sendText() etc.

  WA.bridge = {
    connect,
    disconnect,
    sendText,
    isConnected,
    toggleMic,
    sendPageContext
  };

  // Legacy globals for HTML onclick handlers
  window.elConnect    = connect;
  window.elDisconnect = disconnect;
  window.elToggleMic  = toggleMic;

})();
