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

  // ─── GET CONVERSATION METADATA ────────────────────────────────────────────

  function getConversationMetadata() {
    const userId = getUserId();
    const session = WA.getSession ? WA.getSession() : {};
    
    return {
      user_id: userId || 'anonymous',
      session_id: Date.now().toString(),
      message_count: session.messages?.length || 0,
      has_active_session: (session.messages?.length || 0) > 0
    };
  }

  // ─── SAVE TO BACKEND ──────────────────────────────────────────────────────

  async function saveSessionToBackend() {
    const userId = getUserId();
    const session = WA.getSession ? WA.getSession() : {};
    
    if (!userId) {
      console.log('[SessionSync] ⚠️ No user ID - skipping save');
      return;
    }
    
    if (!session.messages || session.messages.length === 0) {
      console.log('[SessionSync] ⚠️ No messages - skipping save');
      return;
    }

    // Get conversation_id from ElevenLabs (stored in session) or generate fallback
    // ElevenLabs bridge should set session.elevenlabsConversationId when it connects
    const conversationId = session.elevenlabsConversationId || `conv_${Date.now()}`;

    const payload = {
      user_id: userId,
      conversation_id: conversationId,
      transcript: session.messages,
      analysis: {
        lastSaved: new Date().toISOString(),
        messageCount: session.messages.length
      }
    };

    console.log('[SessionSync] 💾 Saving session...', {
      userId,
      messageCount: session.messages.length,
      conversationId: conversationId
    });

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
    // Message hooks disabled - we now save on disconnect only
    // The full session is sent via onDisconnect in wa-elevenlabs.js
    
    console.log('[SessionSync] Message hooks disabled - using disconnect-based saving');
  }

  // ─── PAGE UNLOAD HANDLER ──────────────────────────────────────────────────

  function setupUnloadHandler() {
    window.addEventListener('beforeunload', () => {
      const userId = getUserId();
      const session = WA.getSession ? WA.getSession() : {};
      
      if (!userId || !session.messages || session.messages.length === 0) {
        return;
      }

      const conversationId = session.elevenlabsConversationId || `conv_${Date.now()}`;

      const payload = {
        user_id: userId,
        conversation_id: conversationId,
        transcript: session.messages,
        analysis: {
          lastSaved: new Date().toISOString(),
          messageCount: session.messages.length,
          savedVia: 'page_unload'
        }
      };

      // Use sendBeacon for reliable unload save
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('https://backend.jacob-e87.workers.dev/session', blob);
      
      console.log('[SessionSync] 🚪 Page unload - saving via beacon');
    });
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
    
    // Setup page unload handler
    setupUnloadHandler();
    
    console.log('[SessionSync] ✅ Ready');
    console.log('[SessionSync] User ID:', getUserId());
    
    // Log metadata when first message is sent
    setTimeout(() => {
      const metadata = getConversationMetadata();
      console.log('[SessionSync] 📋 Conversation Metadata:', metadata);
    }, 1000);
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.getUserId = getUserId;
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