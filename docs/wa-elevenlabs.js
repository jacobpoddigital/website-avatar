/**
 * wa-elevenlabs.js — ElevenLabs bridge (text-only / chat mode) - FIXED VERSION
 * 
 * FIXES:
 * - Properly disables audio to prevent WebSocket closing issues
 * - Adds better error handling for connection state
 * - Prevents audio worklet interference in text-only mode
 */

import { Conversation } from 'https://esm.sh/@elevenlabs/client@0.14.0';

(function () {

  const WA    = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const DEBUG = (window.WA_CONFIG || {}).debug || false;

  function log  (...a) { if (DEBUG) console.log ('[WA:Bridge]', ...a); }
  function warn (...a) {           console.warn('[WA:Bridge]', ...a); }

  // ─── USER ID HELPER ──────────────────────────────────────────────────────
  function getUserId() {
    return localStorage.getItem('wc_visitor') || null;
  }

  // ─── STARTUP DIAGNOSTICS ─────────────────────────────────────────────────
  console.log('[WA:Bridge] Module executing');
  console.log('[WA:Bridge] Conversation imported:', typeof Conversation);
  console.log('[WA:Bridge] window.WebsiteAvatar exists:', !!window.WebsiteAvatar);
  console.log('[WA:Bridge] WA.bus exists:', !!WA.bus);
  console.log('[WA:Bridge] WA_CONFIG:', JSON.stringify(window.WA_CONFIG || {}));
  console.log('[WA:Bridge] user_id (wc_visitor):', getUserId());

  if (!Conversation) {
    warn('Failed to import Conversation from @elevenlabs/client');
    return;
  }

  const CONFIG   = window.WA_CONFIG || {};
  const AGENT_ID = CONFIG.elevenlabsAgentId || '';

  console.log('[WA:Bridge] Agent ID:', AGENT_ID || '(MISSING — check backend KV)');

  let session = null;
  let isConnecting = false;
  let shouldBeConnected = false;

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

  function buildUserContext() {
    if (!WA.userContext || !WA.isReturningUser) return null;
    const ctx = WA.userContext;
    const lines = [];
    lines.push('═══════════════════════════════════════════');
    lines.push('🔄 RETURNING VISITOR CONTEXT');
    lines.push('═══════════════════════════════════════════');
    if (ctx.name) lines.push(`Name: ${ctx.name}`);
    if (ctx.email) lines.push(`Email: ${ctx.email}`);
    if (ctx.phone) lines.push(`Phone: ${ctx.phone}`);
    if (ctx.company) lines.push(`Company: ${ctx.company}`);
    if (ctx.websiteUrl) lines.push(`Website: ${ctx.websiteUrl}`);
    if (ctx.businessType) lines.push(`Business Type: ${ctx.businessType}`);
    if (ctx.currentMarketingApproach) lines.push(`Marketing Approach: ${ctx.currentMarketingApproach}`);
    if (ctx.mainChallenge) lines.push(`Main Challenge: ${ctx.mainChallenge}`);
    if (ctx.growthIntent) lines.push(`Growth Intent: ${ctx.growthIntent}`);
    if (ctx.qualificationStage) lines.push(`Qualification Stage: ${ctx.qualificationStage}`);
    if (ctx.lastTopic) lines.push(`Last Topic: ${ctx.lastTopic}`);
    if (WA.lastVisitMessageCount) {
      lines.push(`Previous conversation length: ${WA.lastVisitMessageCount} messages`);
    }
    lines.push('═══════════════════════════════════════════');
    lines.push('');
    lines.push('📋 INSTRUCTIONS:');
    lines.push('- Greet them naturally using their name if you have it');
    lines.push('- Reference their previous conversation or challenge naturally');
    lines.push('- DO NOT re-ask questions you already have answers for');
    lines.push('- Continue from where you left off');
    lines.push('- Never say "I have your context" or "according to my records"');
    lines.push('- Just demonstrate that you remember them naturally');
    lines.push('═══════════════════════════════════════════');
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
  
    if (s.lastUrlValidationFailure) {
      const failure = s.lastUrlValidationFailure;
      const isRecent = Date.now() - failure.attemptedAt < 10000;
      
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
        
        delete s.lastUrlValidationFailure;
        try {
          sessionStorage.setItem('wa_session', JSON.stringify(s));
        } catch(e) {}
      }
    }
  
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

    const completedForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'complete');
    if (completedForm && !sent.has('form_complete')) {
      sent.add('form_complete');
      try { sessionStorage.setItem(sentKey, JSON.stringify([...sent])); } catch {}
      return 'The contact form has been successfully submitted.';
    }

    const deniedForm = (() => {
      const d = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'denied');
      if (!d) return null;
      const navigatedAfter = (s.actions || []).some(
        a => a.type === 'navigate' && a.status === 'complete' &&
             (a.completedAt || 0) > (d.completedAt || 0)
      );
      return navigatedAfter ? null : d;
    })();

    if (deniedForm && !sent.has('form_denied')) {
      sent.add('form_denied');
      try { sessionStorage.setItem(sentKey, JSON.stringify([...sent])); } catch {}
      return 'I notice the contact form wasn\'t completed. Is there anything else I can help you with?';
    }

    return null;
  }

  // ─── CONNECTION MANAGEMENT ────────────────────────────────────────────────

  async function connect() {
    if (isConnecting) {
      console.log('[WA:Bridge] Already connecting — ignoring duplicate call');
      return;
    }

    if (session) {
      console.log('[WA:Bridge] Already connected');
      return;
    }

    if (!AGENT_ID) {
      warn('No agent ID — cannot connect');
      if (typeof WA.agentSay === 'function') WA.agentSay('Configuration error. Please refresh.');
      return;
    }

    isConnecting = true;
    shouldBeConnected = true;

    const btn = document.getElementById('wa-connect-btn');
    if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }
    if (typeof WA.onBridgeConnecting === 'function') WA.onBridgeConnecting();

    try {
      const userId = getUserId();
      const pageContext = buildPageContext();
      const userContext = buildUserContext();
      const reconnectContext = buildReconnectContext();

      const clientTools = (WA.PAGE_CONTEXT?.elements || []).map(el => ({
        name: `scroll_to_${el.id}`,
        description: `Scroll to "${el.text || el.title}" section`,
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }));

      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL FIX: Properly disable audio in text-only mode
      // ═══════════════════════════════════════════════════════════════════════
      const conversationConfig = {
        agentId: AGENT_ID,
        
        // Custom client tools
        clientTools: clientTools.length > 0 ? { tools: clientTools } : undefined,
        
        // CRITICAL FIX: Use textOnly override instead of audio config
        overrides: {
          conversation: {
            textOnly: true  // ← THIS is the correct way per ElevenLabs docs
          },
          agent: {
            firstMessage: null,
            prompt: {
              prompt: [
                pageContext,
                userContext,
                reconnectContext
              ].filter(Boolean).join('\n\n')
            }
          },
          tts: {
            voiceId: CONFIG.elevenlabsVoiceId || undefined
          }
        },
        
        // Session metadata
        metadata: {
          user_id: userId || 'anonymous',
          session_id: Date.now().toString()
        }
      };

      console.log('[WA:Bridge] Starting session with config:', {
        agentId: AGENT_ID,
        mode: 'text',
        audioInputEnabled: false,
        audioOutputEnabled: false,
        hasClientTools: clientTools.length > 0,
        hasUserContext: !!userContext
      });

      session = await Conversation.startSession({
        ...conversationConfig,
        
        // Event handlers must be in the config, not set after
        onConnect: () => {
          console.log('[WA:Bridge] ✅ Connected');
          isConnecting = false;
          log('Connected');
          setConnectUI(true);
      
          const panel = document.getElementById('wa-panel');
          if (panel && !panel.classList.contains('wa-open')) {
            panel.classList.add('wa-open');
            const badge = document.getElementById('wa-badge');
            if (badge) badge.classList.remove('wa-show');
            if (typeof WA._openPanelDirect === 'function') WA._openPanelDirect();
          }
      
          setTimeout(() => {
            if (!session?.sendUserMessage) return;
            const prompt = buildReconnectPrompt();
            if (prompt) {
              log('Reconnect prompt sent');
              session.sendUserMessage(prompt);
            }
          }, 400);
      
          if (typeof WA.onBridgeConnected === 'function') WA.onBridgeConnected();
        },
      
        onDisconnect: () => {
          console.log('[WA:Bridge] ❌ Disconnected');
          isConnecting = false;
          log('Disconnected');
          
          const wasSession = session;
          session = null;
          setConnectUI(false);
          
          // Only trigger reconnect if we should be connected
          if (shouldBeConnected && wasSession) {
            console.log('[WA:Bridge] Unexpected disconnect detected');
            if (typeof WA.onBridgeDisconnected === 'function') {
              WA.onBridgeDisconnected();
            }
          }
        },
      
        onMessage: (msg) => {
          console.log('[WA:Bridge] Message:', msg.source, '| isFinal:', msg.isFinal, '| text:', (msg.message || '').slice(0, 60));
          if (!msg.message) return;
      
          if (msg.source === 'ai') {
            if (msg.isFinal === false) return;
            
            let knowledgeContext = null;
            let cleanText = msg.message;
            
            try {
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
                cleanText = msg.message.replace(/```json[\s\S]*?```/g, '').trim();
              } else {
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
                  cleanText = msg.message.replace(/\{[\s\S]*?"intent"[\s\S]*?\}/, '').trim();
                }
              }
            } catch(e) {
              console.warn('[WA:Bridge] Failed to parse knowledge context:', e);
            }
            
            cleanText = cleanText.replace(/\[[^\]]+\]\s*/g, '').trim();
            cleanText = cleanText.replace(/^Answer:\s*/i, '').trim();
            cleanText = cleanText.replace(/^JSON:\s*/i, '').trim();
            
            if (!cleanText) return;
            
            if (DEBUG) {
              log(`Agent: "${cleanText.slice(0, 80)}"`);
              if (knowledgeContext) log('Knowledge context:', knowledgeContext);
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
          console.error('[WA:Bridge] Error:', err);
          isConnecting = false;
          warn('Error:', err);
          
          if (typeof WA.agentSay === 'function') {
            WA.agentSay('Something went wrong. Please try reconnecting.');
          }
          
          session = null;
          setConnectUI(false);
          
          if (typeof WA.onBridgeDisconnected === 'function') {
            WA.onBridgeDisconnected();
          }
        },
      
        onStatusChange: (info) => {
          console.log('[WA:Bridge] Status:', info.status);
          log('Status:', info.status);
        }
      });
      
      console.log('[WA:Bridge] Session created:', !!session);

    } catch (err) {
      console.error('[WA:Bridge] Connection failed:', err.message, err);
      isConnecting = false;
      warn('Connection failed:', err.message);
      
      if (typeof WA.agentSay === 'function') {
        WA.agentSay('Could not connect. Please check your connection and try again.');
      }
      
      if (btn) { btn.textContent = 'Connect'; btn.disabled = false; }
      
      if (typeof WA.onBridgeDisconnected === 'function') {
        WA.onBridgeDisconnected();
      }
    }
  }

  async function disconnect() {
    shouldBeConnected = false;
    if (!session) return;
    
    console.log('[WA:Bridge] Disconnecting...');
    try { 
      await session.endSession(); 
    } catch(e) {
      console.warn('[WA:Bridge] Error during disconnect:', e);
    }
    
    session = null;
    isConnecting = false;
    setConnectUI(false);
  }

  function sendText(text) {
    if (!session) {
      warn('Cannot send text - not connected');
      return false;
    }
    
    try {
      console.log('[WA:Bridge] Sending text:', text.substring(0, 50));
      session.sendUserMessage(text);
      return true;
    } catch(e) {
      warn('sendText error:', e.message);
      console.error('[WA:Bridge] Send error:', e);
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

  function isConnected() { 
    return !!session && !isConnecting; 
  }

  // ─── UI ───────────────────────────────────────────────────────────────────

  function setConnectUI(connected) {
    const label = document.getElementById('wa-status-label');
    if (label) label.textContent = connected ? 'Connected' : 'Offline';
  }

  // ─── EXPOSE BRIDGE ────────────────────────────────────────────────────────

  WA.bridge = { connect, disconnect, sendText, skipTurn, isConnected };
  WA.getUserId = getUserId;

  console.log('[WA:Bridge] Bridge ready');
  if (WA.bus) {
    WA.bus.emit('bridge:ready');
    console.log('[WA:Bridge] bridge:ready emitted');
    log('Bridge ready');
  } else {
    console.error('[WA:Bridge] WA.bus missing');
    warn('WA.bus not available');
  }

})();