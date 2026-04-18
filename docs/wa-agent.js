/**
 * wa-agent.js — Website Avatar Core (Refactored)
 * Main orchestrator - imports modules, wires together, exposes public API
 * This file must load AFTER core/ and features/ modules
 */

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  const WA = window.WebsiteAvatar;

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  const CONFIG = window.WA_CONFIG || {};
  WA.DEBUG = CONFIG.debug || false;

  // ─── SESSION ──────────────────────────────────────────────────────────────
  // Start with a fresh session; the real data is loaded asynchronously in init()
  // once loadSession() fetches from the backend /session endpoint.
  let session = WA.freshSession();
  WA.getSession = () => session;

  // ─── MESSAGE FLOW ─────────────────────────────────────────────────────────

  function sendMessage() {
    const input = document.getElementById('wa-input');
    const text  = (input ? input.value : '').trim();
    if (!text) return;

    if (input) input.value = '';
    WA.inactivity.justConnected = false;
    userSay(text);
    WA.inactivity.reset();

    // Cancel in-flight AI and dismiss pending cards
    if (WA.formAIController) WA.formAIController.abort();
    if (WA.bridge && WA.bridge.isConnected()) WA.dismissPendingActions(session);

    // Form fill takes priority
    if (WA.formState.active) {
      WA.routeFormInput(text);
      return;
    }

    // Send to bridge if connected
    if (WA.bridge && WA.bridge.isConnected()) {
      WA.bridge.sendText(text);
      WA._lastUserMessage = text;
      WA.showTyping();
      WA.setState('conversation', 'awaiting');
      return;
    }

    // Queue message if bridge offline
    if (WA.bridge) {
      WA.queueMessage(text);
      WA.showTyping();
      if (WA.State.connection === 'offline') {
        WA.reconnectBridge();
      }
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') sendMessage();
  }

  function userSay(text) {
    WA.hideWaitingHint();
    session.messages.push({ role: 'user', text, ts: Date.now() });
    if (WA.State.session === 'fresh') {
      WA.setState('session', 'active');
      WA.updateSessionButton(true);
    }
    WA.saveSession(session);
    WA.appendMessage('user', text);

    // Auto-detect email address in user message and offer to send magic link
    if (typeof WA.detectEmailInMessage === 'function') {
      WA.detectEmailInMessage(text);
    }
  }

  function agentSay(text) {
    WA.hideTyping();
    WA.hideWaitingHint();
    session.messages.push({ role: 'agent', text, ts: Date.now() });
    if (WA.State.session === 'fresh') {
      WA.setState('session', 'active');
      WA.updateSessionButton(true);
    }
    WA.saveSession(session);
    WA.appendMessage('agent', text);

    // Prompt unauthenticated users to save their conversation at user message 3, 6, and 15
    const userMsgCount = session.messages.filter(m => m.role === 'user').length;
    const AUTH_NUDGE_AT = [3, 6, 15];
    const isAuthed = WA.auth && WA.auth.getCurrentUser() && WA.auth.getCurrentUser().isAuthenticated;
    console.log('[WA:AuthNudge] agentSay fired | userMsgCount:', userMsgCount, '| isAuthed:', isAuthed, '| nudgeAt:', AUTH_NUDGE_AT, '| showMagicLinkPrompt available:', typeof WA.showMagicLinkPrompt === 'function');
    if (AUTH_NUDGE_AT.includes(userMsgCount) && !isAuthed) {
      console.log('[WA:AuthNudge] Threshold hit at userMsgCount:', userMsgCount, '— showing magic link prompt');
      if (typeof WA.showMagicLinkPrompt === 'function') {
        WA.showMagicLinkPrompt();
      } else {
        console.warn('[WA:AuthNudge] showMagicLinkPrompt not available on WA');
      }
    }
  }

  // ─── SESSION ARCHIVE ──────────────────────────────────────────────────────

  function archiveSession(s) {
    try {
      const existing = JSON.parse(localStorage.getItem('wa_past_sessions') || '[]');
      existing.unshift({
        id:           s.dialogueConversationId || ('sess_' + Date.now()),
        startedAt:    s.messages[0]?.ts || Date.now(),
        endedAt:      Date.now(),
        messages:     s.messages,
        messageCount: s.messages.length,
        snippet:      s.messages[0]?.text?.slice(0, 80) || ''
      });
      localStorage.setItem('wa_past_sessions', JSON.stringify(existing.slice(0, 20)));
    } catch (e) {
      console.warn('[WA] Failed to archive session:', e);
    }
  }

  // ─── END SESSION ──────────────────────────────────────────────────────────

  async function endSession() {
    if (WA.DEBUG) console.log('[WA] Ending session');
    if (session.messages?.length) archiveSession(session);

    // SAVE SESSION BEFORE DISCONNECTING
    const userId = WA.getUserId ? WA.getUserId() : null;
    if (userId && session.dialogueConversationId && session.messages?.length) {
      if (WA.DEBUG) console.log('[WA] 💾 Saving session before end...');
      
      try {
        const response = await fetch('https://backend.jacob-e87.workers.dev/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            conversation_id: session.dialogueConversationId,
            client_id: WA.getClientId ? WA.getClientId() : '', // account that owns this conversation
            transcript: session.messages,
            analysis: {
              lastSaved: new Date().toISOString(),
              messageCount: session.messages.length,
              endedManually: true
            }
          })
        });
        
        if (response.ok) {
          if (WA.DEBUG) console.log('[WA] ✅ Session saved before end');
        }
      } catch (err) {
        console.error('[WA] ❌ Failed to save session before end:', err);
      }
    }

    WA.clearQueue();
    WA.disconnectBridge();

    // Clear backend KV state and reset session ID (replaces sessionStorage.removeItem calls)
    await WA.clearSession();

    session = WA.freshSession();
    session.isOpen = false;
    WA.resetFormState();

    WA.State.connection   = 'offline';
    WA.State.conversation = 'idle';
    WA.State.action       = 'none';
    WA.State.session      = 'fresh';

    WA.inactivity.reset();
    WA.resetChatUI();

    setTimeout(() => {
      WA.appendMessage('agent', 'Session ended. Open the chat to start a new conversation.');
    }, 300);

    WA.saveSession(session);
    WA.renderDebug();
    if (WA.DEBUG) console.log('[WA] Session ended — fresh state restored');
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  // init() is async so it can await WA.loadSession(), which now fetches
  // persisted session state from the backend /session endpoint before rendering.
  async function init() {
    session = await WA.loadSession();

    // If KV returned a fresh session (no messages) but session-sync.js already loaded
    // transcript history from D1 into WA._previousSession, hydrate the current session
    // with those messages so the user sees their conversation history.
    // We do NOT call saveSession() here — D1 history should not overwrite KV state.
    if (!session.messages.length && WA._previousSession?.messages?.length) {
      session.messages = WA._previousSession.messages;
      if (WA.DEBUG) console.log('[WA] Hydrated session from D1 history:', session.messages.length, 'messages');
    }

    const hasActiveSession = session.messages.length > 0;
    const hasFormResume    = !!(session.activeFormActionId &&
                               session.actions.find(a => a.id === session.activeFormActionId && a.status === 'active'));

    // Restore messages
    const msgs = document.getElementById('wa-messages');
    if (msgs) {
      msgs.innerHTML = '';
      session.messages.forEach(m => WA.appendMessage(m.role, m.text, m.ts));
    }

    // Restore pending action cards
    session.actions.forEach(a => {
      if (a.status === 'pending') WA.renderActionCard(a);
    });

    // Resume interrupted form fill
    if (session.activeFormActionId) {
      const resumeAction = session.actions.find(
        a => a.id === session.activeFormActionId && a.status === 'active'
      );
      if (resumeAction) {
        WA.formState.active = true;
        WA.formState.action = resumeAction;
        WA.repopulateFields(resumeAction);
        WA.updateAbortButton(true);
        setTimeout(() => WA.routeFormInput('__RESUME__'), 400);
      } else {
        session.activeFormActionId = null;
        WA.saveSession(session);
      }
    }

    // Panel state
    if (session.isOpen && session.messages.length > 0) WA.openPanel();
    if (session.messages.length > 0 && !session.isOpen) {
      const badge = document.getElementById('wa-badge');
      if (badge) badge.classList.add('wa-show');
    }

    // Fresh visit
    if (!hasActiveSession) {
      setTimeout(() => {
        const badge = document.getElementById('wa-badge');
        if (badge && !session.isOpen) badge.classList.add('wa-show');
      }, 1500);
    }

    WA.scrollToBottom();
    WA.renderDebug();

    // Auto-connect if session active
    if (hasActiveSession && !hasFormResume) {
      WA.reconnectBridge();
    }

    // Show end session button
    if (hasActiveSession) {
      WA.setState('session', 'active');
      WA.updateSessionButton(true);
    }

    // Setup bridge callbacks
    WA.setupBridgeCallbacks();
  }

  // ─── EXPOSE PUBLIC API ────────────────────────────────────────────────────

  WA.sendMessage          = sendMessage;
  WA.handleKey            = handleKey;
  WA.agentSay             = agentSay;
  WA.userSay              = userSay;
  WA.endSession        = endSession;
  WA._lastUserMessage  = '';

  // ─── START ────────────────────────────────────────────────────────────────

  function waitForPanel(cb, attempts = 0) {
    if (document.getElementById('wa-messages')) {
      cb();
    } else if (attempts < 30) {
      setTimeout(() => waitForPanel(cb, attempts + 1), 100);
    } else {
      console.warn('[WA] wa-messages element never appeared — init aborted');
      const label = document.getElementById('wa-status-label');
      if (label) { label.textContent = 'Unavailable'; label.dataset.status = 'offline'; }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForPanel(init));
  } else {
    waitForPanel(init);
  }

})();