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

  const WA    = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const DEBUG = (window.WA_CONFIG || {}).debug || false;

  function log  (...a) { if (DEBUG) console.log ('[WA:Bridge]', ...a); }
  function warn (...a) {           console.warn('[WA:Bridge]', ...a); }

  if (!Conversation) {
    warn('Failed to import Conversation from @elevenlabs/client');
    return;
  }

  const CONFIG   = window.WA_CONFIG || {};
  const AGENT_ID = CONFIG.elevenlabsAgentId || '';

  log('Module ready | agentId:', AGENT_ID || '(MISSING)');

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
    // Use in-memory session from WA.getSession() instead of reading sessionStorage directly.
    // The session is kept in sync with the backend by saveSession() calls throughout the app.
    const s = WA.getSession ? WA.getSession() : {};
    if (!s.messages?.length) return null;
  
    const lines = ['SESSION CONTEXT:'];
    const recent = s.messages.slice(-8);
    lines.push('RECENT CONVERSATION:');
    recent.forEach(m => lines.push(`  ${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`));
    lines.push('');
  
    // URL validation failure - report FIRST so agent can immediately act
    if (s.lastUrlValidationFailure) {
      const failure = s.lastUrlValidationFailure;
      const isRecent = Date.now() - failure.attemptedAt < 10000; // Last 10 seconds
      
      if (isRecent) {
        lines.push('⚠️ CRITICAL: NAVIGATION FAILURE DETECTED');
        lines.push(`Failed URL: ${failure.targetUrl}`);
        lines.push(`Page label: "${failure.targetLabel}"`);
        lines.push(`User asked: "${failure.userMessage}"`);
        lines.push(`You responded: "${failure.agentResponse}"`);
        lines.push('');
        lines.push('PROBLEM: The URL you suggested returned a 404 error. The page does not exist.');
        lines.push('');
        lines.push('REQUIRED ACTION:');
        lines.push('1. Check the AVAILABLE PAGES list in your context for valid alternatives');
        lines.push('2. Suggest a different page that matches the user\'s intent');
        lines.push('3. If no exact match exists, suggest the closest alternative and explain');
        lines.push('4. Apologize for the confusion and move forward with a valid suggestion');
        lines.push('');
        
        // Clear the failure after reporting and persist via backend (replaces sessionStorage.setItem)
        delete s.lastUrlValidationFailure;
        if (WA.saveSession) WA.saveSession(s); // fire-and-forget
      }
    }
  
    // Active form fill — critical: do NOT say form was submitted
    const activeForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'active');
    if (activeForm) {
      const filled = (activeForm.payload?.fields || []).filter(f => f.value);
      lines.push('CURRENT STATUS: Form fill is IN PROGRESS — the form has NOT been submitted yet.');
      if (filled.length) {
        lines.push('FIELDS FILLED SO FAR:');
        filled.forEach(f => lines.push(`  ${f.label}: ${Array.isArray(f.value) ? f.value.join(', ') : f.value}`));
      }
      lines.push('Do NOT congratulate the user or say the form was submitted. Continue helping them fill it in.');
      lines.push('');
      return lines.join('\n');
    }

    // Completed form
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
        fields.forEach(f => lines.push(`  ${f.label}: ${Array.isArray(f.value) ? f.value.join(', ') : f.value}`));
        lines.push('');
      }
      lines.push('OUTCOME: Contact form submitted successfully.');
    } else if (deniedForm) {
      lines.push('OUTCOME: User did not complete the contact form.');
    }

    return lines.join('\n');
  }

  function buildReconnectPrompt() {
    // Use in-memory session instead of sessionStorage.
    const s = WA.getSession ? WA.getSession() : {};
    if (!s.messages?.length) return null;

    // sentPrompts is now a field on the session object (replaces wa_sent_prompts sessionStorage key)
    const sent = new Set(s.sentPrompts || []);

    // Completed form — acknowledge submission
    const completedForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'complete');
    if (completedForm && !sent.has(completedForm.id)) {
      sent.add(completedForm.id);
      // Persist updated sentPrompts to backend via session (replaces sessionStorage)
      s.sentPrompts = [...sent];
      if (WA.saveSession) WA.saveSession(s); // fire-and-forget
      const fields = completedForm.payload.fields.filter(f => f.value);
      return `[SYSTEM: The contact form was just submitted with: ${fields.map(f => `${f.label}=${f.value}`).join(', ')}. Acknowledge this naturally and ask if there's anything else you can help with.]`;
    }

    // Post-navigation — fire once per page using URL as key
    const pageKey = `page_${window.location.href}`;
    if (!sent.has(pageKey)) {
      sent.add(pageKey);
      // Persist updated sentPrompts to backend via session (replaces sessionStorage)
      s.sentPrompts = [...sent];
      if (WA.saveSession) WA.saveSession(s); // fire-and-forget

      const lastNav = [...(s.actions || [])]
        .filter(a => a.type === 'navigate' && a.status === 'complete')
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0];

      const recentMsgs = s.messages.slice(-4)
        .map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`)
        .join('\n');

      if (lastNav) {
        return `[SYSTEM: You just navigated the user to the ${lastNav.payload.targetLabel} page. Welcome them to the page naturally and offer to help them explore it. Recent conversation:\n${recentMsgs}]`;
      }

      return `[SYSTEM: Continue the conversation naturally. You are now on: ${document.title}. Recent conversation:\n${recentMsgs}]`;
    }

    // Last message was from user — continue from there
    const lastMsg = s.messages[s.messages.length - 1];
    if (lastMsg?.role === 'user') {
      const key = `user_${lastMsg.ts}`;
      if (!sent.has(key)) {
        sent.add(key);
        // Persist updated sentPrompts to backend via session (replaces sessionStorage)
        s.sentPrompts = [...sent];
        if (WA.saveSession) WA.saveSession(s); // fire-and-forget
        return `[SYSTEM: The user's last message was: "${lastMsg.text}". Continue the conversation naturally from here.]`;
      }
    }

    return null;
  }

  // ─── CONVERSATION ID CAPTURE ──────────────────────────────────────────────

  async function captureConversationId(sessionObj) {
    if (!sessionObj) {
      console.warn('[WA:Bridge] ⚠️ No session object provided to captureConversationId');
      return null;
    }
    
    // Poll for getId() to return a value (up to 2 seconds)
    for (let i = 0; i < 10; i++) {
      let conversationId = null;
      
      // Try the documented getId() method
      if (typeof sessionObj.getId === 'function') {
        conversationId = sessionObj.getId();
      }
      
      if (conversationId) {
        return conversationId;
      }
      
      await new Promise(res => setTimeout(res, 200)); // wait 200ms
    }
    
    console.warn('[WA:Bridge] ⚠️ getId() returned null/undefined after 10 attempts');
    log('Session has getId:', typeof sessionObj.getId === 'function', '| keys:', Object.keys(sessionObj || {}));
    
    return null;
  }

  // ─── CONNECTION ───────────────────────────────────────────────────────────

  async function connect() {
    log('connect() called | session:', !!session, '| agentId:', AGENT_ID);

    if (session) {
      log('Already connected — disconnecting first');
      await disconnect();
      return;
    }

    if (!AGENT_ID) {
      warn('No agent ID — check backend KV config');
      return;
    }

    const btn = document.getElementById('wa-connect-btn');
    if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }

    if (typeof WA.onBridgeConnecting === 'function') WA.onBridgeConnecting();

    // ✅ GET SESSION METADATA
    const metadata = WA.getConversationMetadata ? WA.getConversationMetadata() : {
      user_id: 'anonymous',
      session_id: Date.now().toString(),
      message_count: 0
    };

    // Fix: read visitor ID fresh at connect time rather than relying on the cached
    // value inside getConversationMetadata(), which may have been captured before
    // the third-party wc_visitor script had a chance to write to localStorage.
    const resolvedUserId = (WA.getUserId ? WA.getUserId() : null) || metadata.user_id;

    log('🔗 Connecting | user:', resolvedUserId, '| msgs:', metadata.message_count);

    const reconnectCtx  = buildReconnectContext();
    const pageCtx       = buildPageContext();
    const contextToSend = reconnectCtx ? `${pageCtx}\n\n${reconnectCtx}` : pageCtx;

    log('Starting session | context:', contextToSend?.length || 0, 'chars');

    try {
      session = await Conversation.startSession({
        agentId: AGENT_ID,

        // ✅ PASS METADATA TO ELEVENLABS (for their analytics)
        metadata: {
          session_id: metadata.session_id,
          message_count: metadata.message_count,
          timestamp: new Date().toISOString()
        },

        // ✅ PASS USER_ID AND CONTEXT VIA DYNAMIC VARIABLES (more reliable)
        // Uses resolvedUserId — fresh read of wc_visitor — to avoid 'anonymous' fallback
        dynamicVariables: {
          user_id: resolvedUserId,
          context: contextToSend || ''
        },

        onConnect: async function() {
          log('onConnect fired');
          setConnectUI(true);

          // ✅ CAPTURE ELEVENLABS CONVERSATION_ID (with polling)
          // Wait a tick for outer 'session' variable to be assigned
          await new Promise(res => setTimeout(res, 50));
          
          const conversationId = await captureConversationId(session);
          
          if (conversationId) {
            const waSession = WA.getSession ? WA.getSession() : {};
            waSession.elevenlabsConversationId = conversationId;
            if (WA.saveSession) WA.saveSession(waSession);
            console.log('[WA:Bridge] ✅ Connected —', conversationId);
          } else {
            console.warn('[WA:Bridge] ⚠️ Could not capture conversation_id after polling');
            log('Will use fallback ID on save');
          }

          // Open panel directly — do NOT call toggleChat (causes reconnect loop)
          const panel = document.getElementById('wa-panel');
          if (panel && !panel.classList.contains('wa-open')) {
            panel.classList.add('wa-open');
            const badge = document.getElementById('wa-badge');
            if (badge) badge.classList.remove('wa-show');
            if (typeof WA._openPanelDirect === 'function') WA._openPanelDirect();
          }

          // Send reconnect prompt if we have session context
          // On fresh sessions — don't force a greeting, let Michelle respond when user types
          setTimeout(() => {
            if (!session?.sendUserMessage) return;
            const prompt = buildReconnectPrompt();
            if (prompt) {
              log('Reconnect prompt sent');
              session.sendUserMessage(prompt);
            }
            // No prompt = fresh session, no messages yet — Michelle stays quiet
            // until the user initiates
          }, 400);

          if (typeof WA.onBridgeConnected === 'function') WA.onBridgeConnected();
        },

        onDisconnect: async () => {
          log('Disconnected');

          // Send final session data to backend BEFORE clearing session
          const waSession = WA.getSession ? WA.getSession() : {};
          const userId = WA.getUserId ? WA.getUserId() : null;

          if (userId && waSession.elevenlabsConversationId && waSession.messages?.length) {
            log('💾 Saving final session...');

            const payload = {
              user_id: userId,
              conversation_id: waSession.elevenlabsConversationId,
              client_id: WA.getClientId ? WA.getClientId() : '',
              transcript: waSession.messages,
              analysis: {
                lastSaved: new Date().toISOString(),
                messageCount: waSession.messages.length,
                disconnectedAt: new Date().toISOString()
              }
            };

            try {
              const response = await fetch('https://backend.jacob-e87.workers.dev/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });

              if (response.ok) {
                console.log('[WA:Bridge] 💾 Session saved —', waSession.messages.length, 'messages');
              } else {
                console.warn('[WA:Bridge] ⚠️ Failed to save session:', response.status);
              }
            } catch (err) {
              console.error('[WA:Bridge] ❌ Error saving session:', err);
            }
          } else {
            log('Skipping disconnect save — missing data');
          }
          
          // Now clear session and update UI
          session = null;
          setConnectUI(false);
          if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
        },

        onMessage: (msg) => {
          log('onMessage:', msg.source, '| isFinal:', msg.isFinal, '| text:', (msg.message || '').slice(0, 60));
          if (!msg.message) return;

          if (msg.source === 'ai') {
            // In text-only mode isFinal may be undefined — only skip if explicitly false
            if (msg.isFinal === false) return;
            
            // Parse knowledge context from JSON if present
            let knowledgeContext = null;
            let cleanText = msg.message;
            
            try {
              // Look for JSON block in response (```json ... ```)
              const jsonMatch = msg.message.match(/```json\s*(\{[\s\S]*?\})\s*```/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[1]);
                knowledgeContext = {
                  intent: parsed.intent || null,
                  target_page: parsed.page && parsed.page !== 'unknown' ? parsed.page : null,
                  section: parsed.section && parsed.section !== 'unknown' ? parsed.section : null,
                  confidence: parsed.confidence || 0.8,
                  keywords: parsed.keywords || [],
                  matched_text: parsed.answer || cleanText
                };
                // Remove JSON block from display text
                cleanText = msg.message.replace(/```json[\s\S]*?```/g, '').trim();
              } else {
                // Fallback: try to find raw JSON object
                const rawJsonMatch = msg.message.match(/\{[\s\S]*?"intent"[\s\S]*?\}/);
                if (rawJsonMatch) {
                  const parsed = JSON.parse(rawJsonMatch[0]);
                  knowledgeContext = {
                    intent: parsed.intent || null,
                    target_page: parsed.page && parsed.page !== 'unknown' ? parsed.page : null,
                    section: parsed.section && parsed.section !== 'unknown' ? parsed.section : null,
                    confidence: parsed.confidence || 0.8,
                    keywords: parsed.keywords || [],
                    matched_text: parsed.answer || cleanText
                  };
                  // Remove JSON from display text
                  cleanText = msg.message.replace(/\{[\s\S]*?"intent"[\s\S]*?\}/, '').trim();
                }
              }
            } catch(e) {
              console.warn('[WA:Bridge] Failed to parse knowledge context:', e);
            }
            
            // Clean up system markers and formatting
            cleanText = cleanText.replace(/\[[^\]]+\]\s*/g, '').trim();
            cleanText = cleanText.replace(/^Answer:\s*/i, '').trim();
            cleanText = cleanText.replace(/^JSON:\s*/i, '').trim();
            
            if (!cleanText) return;
            
            if (DEBUG) {
              log(`Agent: "${cleanText.slice(0, 80)}"`);
              if (knowledgeContext) {
                log('Knowledge context:', knowledgeContext);
              }
            }
            
            if (typeof WA.onAgentMessage === 'function') {
              WA.onAgentMessage(cleanText, knowledgeContext);
            }
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
          console.error('[WA:Bridge] onError:', err);
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
      console.error('[WA:Bridge] startSession threw:', err.message, err);
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

  function skipTurn() {
    if (!session?.skipTurn) {
      warn('skipTurn not available');
      return false;
    }
    try {
      session.skipTurn();
      log('Turn skipped');
      return true;
    } catch(e) {
      warn('skipTurn error:', e.message);
      return false;
    }
  }

  function isConnected() { return !!session; }

  // ─── UI ───────────────────────────────────────────────────────────────────

  function setConnectUI(connected) {
    const label = document.getElementById('wa-status-label');
    if (label) label.textContent = connected ? 'Connected' : 'Offline';
  }

  // ─── EXPOSE BRIDGE ────────────────────────────────────────────────────────

  WA.bridge = { connect, disconnect, sendText, skipTurn, isConnected };

  if (WA.bus) {
    WA.bus.emit('bridge:ready');
    log('bridge:ready emitted');
  } else {
    console.error('[WA:Bridge] WA.bus missing — wa-agent.js namespace problem');
    warn('WA.bus not available — wa-agent.js may not have loaded');
  }

})();