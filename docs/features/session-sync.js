/**
 * wa-session-sync.js — Backend Session Persistence
 * Saves and loads sessions from /session endpoint
 * Maintains user context across visits
 */

(function () {
    const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  
    let saveTimeout = null;
    let lastSavedMessageCount = 0;
    let initialized = false;
  
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
          actions: session.actions || [],
          userContext: WA.userContext || {},
          state: {
            qualificationStage: WA.userContext?.qualificationStage || null,
            lastTopic: WA.userContext?.lastTopic || null,
            sessionState: WA.State || {}
          },
          metadata: {
            pageContext: WA.PAGE_CONTEXT?.summary || null,
            lastSaved: new Date().toISOString(),
            url: window.location.href,
            title: document.title
          }
        }
      };
  
      try {
        const response = await fetch('/session', {
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
        const response = await fetch(`/session?user_id=${userId}`);
        
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
  
    // ─── CONTEXT EXTRACTION ───────────────────────────────────────────────────
  
    function extractUserContext(message, role) {
      if (!WA.userContext) WA.userContext = {};
      const context = WA.userContext;
      const text = message.toLowerCase();
  
      // Name extraction (simple patterns)
      if (role === 'user') {
        const nameMatch = message.match(/(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
        if (nameMatch && !context.name) {
          context.name = nameMatch[1];
          if (WA.DEBUG) console.log('[WA:SessionSync] Extracted name:', context.name);
        }
      }
  
      // Email extraction
      const emailMatch = message.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
      if (emailMatch && !context.email) {
        context.email = emailMatch[0];
        if (WA.DEBUG) console.log('[WA:SessionSync] Extracted email:', context.email);
      }
  
      // Phone extraction (UK formats)
      const phoneMatch = message.match(/(?:07\d{9}|(?:\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}|\d{5}\s?\d{6})/);
      if (phoneMatch && !context.phone) {
        context.phone = phoneMatch[0];
        if (WA.DEBUG) console.log('[WA:SessionSync] Extracted phone:', context.phone);
      }
  
      // Website URL extraction
      const urlMatch = message.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/);
      if (urlMatch && !context.websiteUrl) {
        context.websiteUrl = urlMatch[0];
        if (WA.DEBUG) console.log('[WA:SessionSync] Extracted website:', context.websiteUrl);
      }
  
      // Business type extraction
      const businessTypes = [
        'restaurant', 'law firm', 'solicitor', 'accountant', 'dentist', 
        'clinic', 'salon', 'gym', 'estate agent', 'plumber', 'electrician',
        'agency', 'consultancy', 'ecommerce', 'shop', 'store'
      ];
      if (!context.businessType) {
        const businessMatch = businessTypes.find(type => text.includes(type));
        if (businessMatch) {
          context.businessType = businessMatch;
          if (WA.DEBUG) console.log('[WA:SessionSync] Extracted business type:', context.businessType);
        }
      }
  
      // Challenge extraction
      if (role === 'agent' && !context.mainChallenge) {
        const challenges = [
          'not enough enquiries', 'not enough leads', 'poor visibility', 
          'low rankings', 'need more customers', 'need more traffic',
          'website not converting', 'not showing up on google'
        ];
        const challengeMatch = challenges.find(c => text.includes(c));
        if (challengeMatch) {
          context.mainChallenge = challengeMatch;
          if (WA.DEBUG) console.log('[WA:SessionSync] Extracted challenge:', context.mainChallenge);
        }
      }
  
      // Growth intent signals
      if (role === 'user') {
        if ((text.includes('looking to grow') || text.includes('want to grow') || 
             text.includes('need to grow') || text.includes('actively growing')) && !context.growthIntent) {
          context.growthIntent = 'actively looking to grow';
          if (WA.DEBUG) console.log('[WA:SessionSync] Growth intent detected');
        }
      }
  
      // Marketing approach
      if (role === 'user' && !context.currentMarketingApproach) {
        if (text.includes('referrals') || text.includes('word of mouth')) {
          context.currentMarketingApproach = 'referrals';
        } else if (text.includes('seo') || text.includes('organic')) {
          context.currentMarketingApproach = 'seo';
        } else if (text.includes('paid ads') || text.includes('ppc') || text.includes('google ads')) {
          context.currentMarketingApproach = 'paid advertising';
        }
        if (context.currentMarketingApproach && WA.DEBUG) {
          console.log('[WA:SessionSync] Extracted marketing approach:', context.currentMarketingApproach);
        }
      }
  
      // Update timestamps
      context.lastInteraction = Date.now();
      if (!context.firstVisit) {
        context.firstVisit = Date.now();
      }
  
      WA.userContext = context;
    }
  
    // ─── PAGE UNLOAD HANDLER ──────────────────────────────────────────────────
  
    function setupUnloadHandler() {
      window.addEventListener('beforeunload', () => {
        // Use sendBeacon for reliable delivery
        const userId = getUserId();
        const session = WA.getSession ? WA.getSession() : {};
        
        if (!userId || !session.messages || session.messages.length === 0) return;
  
        const payload = JSON.stringify({
          user_id: userId,
          conversation_id: getConversationId(),
          transcript: session.messages,
          analysis: {
            actions: session.actions || [],
            userContext: WA.userContext || {},
            state: {
              qualificationStage: WA.userContext?.qualificationStage || null,
              lastTopic: WA.userContext?.lastTopic || null
            },
            metadata: {
              pageContext: WA.PAGE_CONTEXT?.summary || null,
              lastSaved: new Date().toISOString(),
              url: window.location.href,
              title: document.title,
              unloadSave: true
            }
          }
        });
  
        navigator.sendBeacon('/session', new Blob([payload], { type: 'application/json' }));
        if (WA.DEBUG) console.log('[WA:SessionSync] Beacon sent on unload');
      });
    }
  
    // ─── INTEGRATE WITH EXISTING FLOW ─────────────────────────────────────────
  
    function hookIntoMessageFlow() {
      // Store originals
      const originalUserSay = WA.userSay;
      const originalAgentSay = WA.agentSay;
  
      if (originalUserSay) {
        WA.userSay = function(text) {
          originalUserSay.call(this, text);
          extractUserContext(text, 'user');
          debouncedSave();
        };
      }
  
      if (originalAgentSay) {
        WA.agentSay = function(text) {
          originalAgentSay.call(this, text);
          extractUserContext(text, 'agent');
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
  
      // Load previous session first
      await loadSessionFromBackend();
  
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
    WA.extractUserContext = extractUserContext;
  
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