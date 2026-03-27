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

  // ─── STARTUP DIAGNOSTICS ─────────────────────────────────────────────────
  console.log('[WA:Bridge] Module executing');
  console.log('[WA:Bridge] Conversation imported:', typeof Conversation);
  console.log('[WA:Bridge] window.WebsiteAvatar exists:', !!window.WebsiteAvatar);
  console.log('[WA:Bridge] WA.bus exists:', !!WA.bus);
  console.log('[WA:Bridge] WA_CONFIG:', JSON.stringify(window.WA_CONFIG || {}));

  if (!Conversation) {
    warn('Failed to import Conversation from @elevenlabs/client');
    return;
  }

  const CONFIG   = window.WA_CONFIG || {};
  const AGENT_ID = CONFIG.elevenlabsAgentId || '';

  console.log('[WA:Bridge] Agent ID:', AGENT_ID || '(MISSING — check backend KV)');

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
        
        // Clear the failure after reporting
        delete s.lastUrlValidationFailure;
        try {
          sessionStorage.setItem('wa_session', JSON.stringify(s));
        } catch(e) {}
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
    const s = (() => {
      try { return JSON.parse(sessionStorage.getItem('wa_session') || '{}'); } catch { return {}; }
    })();
    if (!s.messages?.length) return null;

    const sentKey = 'wa_sent_prompts';
    const sent = (() => {
      try { return new Set(JSON.parse(sessionStorage.getItem(sentKey) || '[]')); } catch { return new Set(); }
    })();

    // Completed form — acknowledge submission
    const completedForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'complete');
    if (completedForm && !sent.has(completedForm.id)) {
      sent.add(completedForm.id);
      sessionStorage.setItem(sentKey, JSON.stringify([...sent]));
      const fields = completedForm.payload.fields.filter(f => f.value);
      return `[SYSTEM: The contact form was just submitted with: ${fields.map(f => `${f.label}=${f.value}`).join(', ')}. Acknowledge this naturally and ask if there's anything else you can help with.]`;
    }

    // Post-navigation — fire once per page using URL as key
    const pageKey = `page_${window.location.href}`;
    if (!sent.has(pageKey)) {
      sent.add(pageKey);
      sessionStorage.setItem(sentKey, JSON.stringify([...sent]));

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
        sessionStorage.setItem(sentKey, JSON.stringify([...sent]));
        return `[SYSTEM: The user's last message was: "${lastMsg.text}". Continue the conversation naturally from here.]`;
      }
    }

    return null;
  }

  // ─── CONNECTION ───────────────────────────────────────────────────────────

  async function connect() {
    console.log('[WA:Bridge] connect() called — session:', !!session, '| agentId:', AGENT_ID);

    if (session) {
      console.log('[WA:Bridge] Already connected — disconnecting first');
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

    const reconnectCtx  = buildReconnectContext();
    const pageCtx       = buildPageContext();
    const contextToSend = reconnectCtx ? `${pageCtx}\n\n${reconnectCtx}` : pageCtx;

    console.log('[WA:Bridge] Calling Conversation.startSession...');
    console.log('[WA:Bridge] Context length:', contextToSend?.length || 0, 'chars');

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
          console.log('[WA:Bridge] onConnect fired — session established');
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

        onDisconnect: () => {
          console.log('[WA:Bridge] onDisconnect fired');
          log('Disconnected');
          session = null;
          setConnectUI(false);
          if (typeof WA.onBridgeDisconnected === 'function') WA.onBridgeDisconnected();
        },

        onMessage: (msg) => {
          console.log('[WA:Bridge] onMessage:', msg.source, '| isFinal:', msg.isFinal, '| text:', (msg.message || '').slice(0, 60));
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
          console.log('[WA:Bridge] onStatusChange:', info.status);
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

  console.log('[WA:Bridge] Reached bridge:ready emit — WA.bus:', !!WA.bus);
  if (WA.bus) {
    WA.bus.emit('bridge:ready');
    console.log('[WA:Bridge] bridge:ready emitted');
    log('Bridge ready');
  } else {
    console.error('[WA:Bridge] WA.bus missing — wa-agent.js namespace problem');
    warn('WA.bus not available — wa-agent.js may not have loaded');
  }

})();