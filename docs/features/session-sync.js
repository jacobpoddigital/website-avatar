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
  
  function getUserId() {
    return localStorage.getItem('wc_visitor') || null;
  }

  // ─── SAVE TO BACKEND ──────────────────────────────────────────────────────

  async function saveSessionToBackend() {
    const userId = getUserId();
    const session = WA.getSession ? WA.getSession() : {};
    
    if (!userId || !session.messages || session.messages.length === 0) {
      return;
    }

    const payload = {
      user_id: userId,
      conversation_id: session.conversationId || `conv_${Date.now()}`,
      transcript: session.messages,
      analysis: {
        lastSaved: new Date().toISOString(),
        messageCount: session.messages.length
      }
    };

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
    
    if (!userId) {
      console.log('[SessionSync] No user ID, skipping load');
      return null;
    }

    try {
      const response = await fetch(`${SESSION_URL}?user_id=${userId}`);
      
      if (!response.ok) {
        console.log('[SessionSync] No previous session found');
        return null;
      }

      const sessions = await response.json();
      
      if (!sessions || sessions.length === 0) {
        console.log('[SessionSync] No sessions returned');
        return null;
      }

      const lastSession = sessions[0];
      
      // Parse transcript
      let transcript = lastSession.transcript;
      if (typeof transcript === 'string') {
        transcript = JSON.parse(transcript);
      }

      console.log('[SessionSync] ✅ Loaded previous session');
      console.log('[SessionSync] Messages:', transcript.length);
      console.log('[SessionSync] Preview:', transcript.slice(0, 3));
      
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

  // ─── HOOK INTO MESSAGE FLOW ───────────────────────────────────────────────

  function hookIntoMessages() {
    const originalUserSay = WA.userSay;
    const originalAgentSay = WA.agentSay;

    if (originalUserSay) {
      WA.userSay = function(text) {
        originalUserSay.call(this, text);
        debouncedSave(); // Save after user message
      };
    }

    if (originalAgentSay) {
      WA.agentSay = function(text) {
        originalAgentSay.call(this, text);
        debouncedSave(); // Save after agent message
      };
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  async function init() {
    console.log('[SessionSync] Initializing...');
    
    // Load previous session
    const previousSession = await loadSessionFromBackend();
    
    if (previousSession) {
      console.log('[SessionSync] 📦 Session data loaded - ready to use');
      // Store for potential future use
      WA._previousSession = previousSession;
    }
    
    // Hook into message flow
    hookIntoMessages();
    
    console.log('[SessionSync] ✅ Ready');
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.getUserId = getUserId;
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