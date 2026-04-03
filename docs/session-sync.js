/**
 * session-sync.js — Minimal Backend Session Persistence
 * Saves conversation to backend, loads on page load
 */

(function () {
  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const CONFIG = window.WA_CONFIG || {};
  const SESSION_URL = CONFIG.sessionUrl || 'https://backend.jacob-e87.workers.dev/session';
  
  let saveTimeout = null;

  // ─── GET USER ID ──────────────────────────────────────────────────────────
  // Returns authenticated user ID if signed in, otherwise falls back to wc_visitor.

  function getUserId() {
    if (WA.auth) {
      const user = WA.auth.getCurrentUser();
      return user.id;
    }
    return localStorage.getItem('wc_visitor') || null;
  }

  // ─── GET CLIENT ID ────────────────────────────────────────────────────────
  // Reads the accountId that was set on the script tag (data-account-id) and
  // stored in WA_CONFIG.clientId during boot. Used to tag every D1 record so
  // conversations are always queryable by the account that owns them.

  function getClientId() {
    return (window.WA_CONFIG || {}).clientId || '';
  }

  // ─── GET CONVERSATION METADATA ────────────────────────────────────────────

  function getConversationMetadata() {
    const userId = getUserId();
    const session = WA.getSession ? WA.getSession() : {};
    // Use the stable wa_session_id (localStorage) rather than a fresh timestamp so
    // the session_id is consistent with our KV state key.
    const sessionId = WA.getSessionId ? WA.getSessionId() : Date.now().toString();

    return {
      user_id: userId || 'anonymous',
      session_id: sessionId,
      message_count: session.messages?.length || 0,
      has_active_session: (session.messages?.length || 0) > 0
    };
  }

  // ─── SAVE TO BACKEND ──────────────────────────────────────────────────────

  async function saveSessionToBackend() {
    const userId = getUserId();
    const session = WA.getSession ? WA.getSession() : {};

    if (!userId) return;
    if (!session.messages || session.messages.length === 0) return;

    // Get conversation_id from Dialogue (stored in session) or generate fallback
    const conversationId = session.dialogueConversationId || `conv_${Date.now()}`;

    const payload = {
      user_id:         userId,
      conversation_id: conversationId,
      client_id:       getClientId(),
      transcript:      session.messages,
      analysis: {
        lastSaved:    new Date().toISOString(),
        messageCount: session.messages.length
      }
    };

    if (WA.DEBUG) console.log('[SessionSync] 💾 Saving session...', { userId, clientId: payload.client_id, messageCount: session.messages.length, conversationId });

    try {
      const response = await fetch(SESSION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log('[SessionSync] ✅ Saved:', session.messages.length, 'messages');
      } else {
        console.warn('[SessionSync] ⚠️ Save failed with status:', response.status);
      }
    } catch (err) {
      console.error('[SessionSync] ❌ Save failed:', err);
    }
  }

  function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveSessionToBackend(), 3000);
  }

  // ─── LOAD FROM BACKEND ────────────────────────────────────────────────────

  async function loadSessionFromBackend() {
    const userId = getUserId();

    if (!userId) return null;

    try {
      const clientId = getClientId();
      const sessionQuery = clientId
        ? `${SESSION_URL}?user_id=${userId}&client_id=${encodeURIComponent(clientId)}`
        : `${SESSION_URL}?user_id=${userId}`;
      const response = await fetch(sessionQuery);

      if (!response.ok) return null;

      const sessions = await response.json();

      if (!sessions || sessions.length === 0) return null;

      const lastSession = sessions[0];

      // Parse transcript for the most recent session (used as active chat)
      let transcript = lastSession.transcript;
      if (typeof transcript === 'string') {
        transcript = JSON.parse(transcript);
      }

      // Sync all sessions into localStorage history so the history panel shows them.
      // Only backfills entries that aren't already there (matched by conversation_id).
      try {
        const existing = JSON.parse(localStorage.getItem('wa_past_sessions') || '[]');
        const existingIds = new Set(existing.map(s => s.id));
        const toAdd = sessions
          .filter(s => !existingIds.has(s.conversation_id))
          .map(s => {
            let msgs = s.transcript;
            if (typeof msgs === 'string') { try { msgs = JSON.parse(msgs); } catch { msgs = []; } }
            return {
              id:           s.conversation_id,
              startedAt:    msgs[0]?.ts || new Date(s.created_at).getTime(),
              endedAt:      msgs[msgs.length - 1]?.ts || new Date(s.created_at).getTime(),
              messages:     msgs,
              messageCount: msgs.length,
              snippet:      msgs[0]?.text?.slice(0, 80) || ''
            };
          });
        if (toAdd.length) {
          const merged = [...toAdd, ...existing].slice(0, 50);
          localStorage.setItem('wa_past_sessions', JSON.stringify(merged));
          console.log('[SessionSync] 📚 Synced', toAdd.length, 'session(s) to history panel');
        }
      } catch (e) {
        console.warn('[SessionSync] Could not sync history:', e);
      }

      console.log('[SessionSync] ✅ Loaded previous session —', transcript.length, 'messages');

      return {
        messages: transcript,
        conversationId: lastSession.conversation_id,
        lastSaved: lastSession.analysis?.lastSaved
      };

    } catch (err) {
      console.error('[SessionSync] ❌ Load failed:', err);
      return null;
    }
  }

  // ─── PAGE UNLOAD HANDLER ──────────────────────────────────────────────────

  function setupUnloadHandler() {
    window.addEventListener('beforeunload', (e) => {
      const userId = getUserId();
      const session = WA.getSession ? WA.getSession() : {};
      
      if (!userId || !session.messages || session.messages.length === 0) {
        return; // No active session, allow close without prompt
      }

      const conversationId = session.dialogueConversationId || `conv_${Date.now()}`;

      const payload = {
        user_id:         userId,
        conversation_id: conversationId,
        client_id:       getClientId(),
        transcript:      session.messages,
        analysis: {
          lastSaved:    new Date().toISOString(),
          messageCount: session.messages.length,
          savedVia:     'page_unload'
        }
      };

      // Use sendBeacon for guaranteed delivery
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const sent = navigator.sendBeacon('https://backend.jacob-e87.workers.dev/session', blob);
      
      console.log('[SessionSync] 🚪 Page unload - beacon sent:', sent);

      // Show confirmation dialog to give beacon time to send
      // This also warns user they have an active chat
      e.preventDefault();
      e.returnValue = ''; // Chrome requires returnValue to be set
      
      // Modern browsers will show a generic message like:
      // "Changes you made may not be saved. Are you sure you want to leave?"
      return '';
    });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  async function init() {
    const previousSession = await loadSessionFromBackend();

    if (previousSession) {
      WA._previousSession = previousSession;
    }

    setupUnloadHandler();

    console.log('[SessionSync] ✅ Ready | User:', getUserId());

    setTimeout(() => {
      const metadata = getConversationMetadata();
      console.log('[SessionSync] 📋 Conversation Metadata:', metadata);
    }, 1000);
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.getUserId = getUserId;
  WA.getClientId = getClientId;
  WA.getConversationMetadata = getConversationMetadata;
  WA.loadSessionFromBackend = loadSessionFromBackend;
  WA.saveSessionToBackend = saveSessionToBackend;

  // Wait for WA to be ready
  function waitForWA() {
    if (typeof WA.getSession === 'function' && typeof WA.userSay === 'function') {
      init();
    } else {
      setTimeout(waitForWA, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForWA);
  } else {
    waitForWA();
  }

})();