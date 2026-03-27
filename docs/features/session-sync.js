/**
 * wa-session-sync.js — Backend Session Persistence
 * Saves and loads sessions from /session endpoint
 * Maintains user context across visits
 */

(function () {
  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const CONFIG = window.WA_CONFIG || {};
  const SESSION_URL = CONFIG.sessionUrl || 'https://backend.jacob-e87.workers.dev/session';
  
  let saveTimeout = null;
  let lastSavedMessageCount = 0;
  let initialized = false;
  let hasLoadedInitialSession = false; // ← NEW: Track if we've loaded session on page load

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  function getUserId() {
    return localStorage.getItem('wc_visitor') || null;
  }

  function getConversationId() {
    const session = WA.getSession ? WA.getSession() : {};
    if (!session.conversationId) {
      session.conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      if (WA.saveSession) WA.saveSession(session);
    }
    return session.conversationId;
  }

  // ─── SAVE TO BACKEND ──────────────────────────────────────────────────────

  async function saveSessionToBackend(immediate = false) {
    const userId = getUserId();
    const session = WA.getSession ? WA.getSession() : {};
    
    if (!userId) {
      if (WA.DEBUG) console.warn('[WA:SessionSync] No wc_visitor found, cannot save session');
      return;
    }

    if (!session.messages || session.messages.length === 0) {
      if (WA.DEBUG) console.log('[WA:SessionSync] No messages to save');
      return;
    }

    // Skip if no new messages since last save
    if (session.messages.length === lastSavedMessageCount && !immediate) {
      if (WA.DEBUG) console.log('[WA:SessionSync] No new messages, skipping save');
      return;
    }

    const payload = {
      user_id: userId,
      conversation_id: getConversationId(),
      transcript: session.messages,
      analysis: {
        userContext: WA.userContext || {},
        metadata: {
          lastSaved: new Date().toISOString(),
          url: window.location.href,
          title: document.title
        }
      }
    };

    try {
      const response = await fetch(SESSION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Session save failed: ${response.status}`);
      }

      lastSavedMessageCount = session.messages.length;
      if (WA.DEBUG) console.log('[WA:SessionSync] Session saved to backend', payload.conversation_id);
    } catch (err) {
      console.error('[WA:SessionSync] Failed to save session:', err);
    }
  }

  function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveSessionToBackend(false);
    }, 5000); // 5 second debounce
  }

  function immediateSave() {
    clearTimeout(saveTimeout);
    return saveSessionToBackend(true);
  }

  // ─── LOAD FROM BACKEND ────────────────────────────────────────────────────

  async function loadSessionFromBackend() {
    const userId = getUserId();
    
    if (!userId) {
      if (WA.DEBUG) console.warn('[WA:SessionSync] No wc_visitor found, cannot load session');
      return null;
    }

    try {
      const response = await fetch(`${SESSION_URL}?user_id=${userId}`);
      
      if (!response.ok) {
        throw new Error(`Session load failed: ${response.status}`);
      }

      const sessions = await response.json();
      
      if (!sessions || sessions.length === 0) {
        if (WA.DEBUG) console.log('[WA:SessionSync] No previous sessions found');
        return null;
      }

      const lastSession = sessions[0]; // Most recent
      if (WA.DEBUG) console.log('[WA:SessionSync] Loaded previous session', lastSession);

      // Parse analysis if it's stringified
      let analysis = lastSession.analysis;
      if (typeof analysis === 'string') {
        try {
          analysis = JSON.parse(analysis);
        } catch(e) {
          console.warn('[WA:SessionSync] Failed to parse analysis JSON');
        }
      }

      // Restore user context
      if (analysis?.userContext) {
        WA.userContext = analysis.userContext;
        if (WA.DEBUG) console.log('[WA:SessionSync] Restored user context', WA.userContext);
      }

      // Parse transcript if it's stringified
      let transcript = lastSession.transcript;
      if (typeof transcript === 'string') {
        try {
          transcript = JSON.parse(transcript);
        } catch(e) {
          console.warn('[WA:SessionSync] Failed to parse transcript JSON');
        }
      }

      // Mark as returning user
      if (transcript && transcript.length > 0) {
        WA.isReturningUser = true;
        WA.lastVisitMessageCount = transcript.length;
        if (WA.DEBUG) console.log('[WA:SessionSync] Returning user detected, previous messages:', transcript.length);
      }

      return lastSession;
    } catch (err) {
      console.error('[WA:SessionSync] Failed to load session:', err);
      return null;
    }
  }

  // ─── PAGE UNLOAD HANDLER ──────────────────────────────────────────────────

  function setupUnloadHandler() {
    window.addEventListener('beforeunload', () => {
      const userId = getUserId();
      const session = WA.getSession ? WA.getSession() : {};
      
      if (!userId || !session.messages || session.messages.length === 0) return;

      const payload = JSON.stringify({
        user_id: userId,
        conversation_id: getConversationId(),
        transcript: session.messages,
        analysis: {
          userContext: WA.userContext || {},
          metadata: {
            lastSaved: new Date().toISOString(),
            url: window.location.href,
            title: document.title,
            unloadSave: true
          }
        }
      });

      navigator.sendBeacon(SESSION_URL, new Blob([payload], { type: 'application/json' }));
      if (WA.DEBUG) console.log('[WA:SessionSync] Beacon sent on unload');
    });
  }

  // ─── INTEGRATE WITH EXISTING FLOW ─────────────────────────────────────────

  function hookIntoMessageFlow() {
    const originalUserSay = WA.userSay;
    const originalAgentSay = WA.agentSay;

    if (originalUserSay) {
      WA.userSay = function(text) {
        originalUserSay.call(this, text);
        debouncedSave();
      };
    }

    if (originalAgentSay) {
      WA.agentSay = function(text) {
        originalAgentSay.call(this, text);
        debouncedSave();
      };
    }

    if (WA.DEBUG) console.log('[WA:SessionSync] Hooked into message flow');
  }

  function hookIntoDisconnect() {
    const originalOnDisconnected = WA.onBridgeDisconnected;
    
    if (originalOnDisconnected) {
      WA.onBridgeDisconnected = async function() {
        await immediateSave();
        if (WA.DEBUG) console.log('[WA:SessionSync] Saved on disconnect');
        originalOnDisconnected.call(this);
      };
    }
  }

  function hookIntoSessionEnd() {
    const originalEndSession = WA.endSession;
    
    if (originalEndSession) {
      WA.endSession = async function() {
        await immediateSave();
        if (WA.DEBUG) console.log('[WA:SessionSync] Saved on session end');
        originalEndSession.call(this);
      };
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  async function init() {
    if (initialized) {
      console.warn('[WA:SessionSync] Already initialized');
      return;
    }

    console.log('[WA:SessionSync] Initializing...');

    // Initialize user context object
    if (!WA.userContext) WA.userContext = {};

    // Only load from backend on initial page load
    if (!hasLoadedInitialSession) {
      await loadSessionFromBackend();
      hasLoadedInitialSession = true;
    } else {
      if (WA.DEBUG) console.log('[WA:SessionSync] Skipping session load (already loaded on page load)');
    }

    // Hook into message flow
    hookIntoMessageFlow();
    hookIntoDisconnect();
    hookIntoSessionEnd();

    // Setup unload handler
    setupUnloadHandler();

    initialized = true;
    console.log('[WA:SessionSync] ✅ Initialized');
    if (WA.DEBUG && WA.isReturningUser) {
      console.log('[WA:SessionSync] 🔄 Returning user detected');
      console.log('[WA:SessionSync] User context:', WA.userContext);
    }
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.getUserId = getUserId;
  WA.saveSessionToBackend = immediateSave;
  WA.loadSessionFromBackend = loadSessionFromBackend;

  // Wait for WA.getSession to be available before initializing
  function waitForSession() {
    if (typeof WA.getSession === 'function' && typeof WA.saveSession === 'function') {
      init();
    } else {
      setTimeout(waitForSession, 100);
    }
  }

  // Auto-init when ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForSession);
  } else {
    waitForSession();
  }

})();