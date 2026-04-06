/**
 * wa-dialogue.js — Dialogue bridge (text-only / chat mode)
 * Uses the Dialogue client SDK via esm.sh CDN
 * Connects to the Dialogue conversational agent in text-only mode.
 * No audio, no microphone.
 *
 * IMPORTANT: In the Dialogue agent dashboard → agent Security tab,
 * ensure "Allow conversation config overrides" is enabled.
 */

import { Conversation } from 'https://esm.sh/@elevenlabs/client@0.14.0';

(function () {

  const WA    = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const DEBUG = (window.WA_CONFIG || {}).debug || false;

  function log  (...a) { if (DEBUG) console.log ('[WA:Bridge]', ...a); }
  function warn (...a) {           console.warn('[WA:Bridge]', ...a); }

  if (!Conversation) {
    warn('Failed to import Conversation from Dialogue client SDK — removing widget');
    _removeWidget();
    return;
  }

  const CONFIG   = window.WA_CONFIG || {};
  const AGENT_ID = CONFIG.dialogueAgentId || '';

  log('Module ready | agentId:', AGENT_ID || '(MISSING)');

  // Removes all widget elements from the DOM. Called when a fatal error means the
  // chat cannot function at all — better to show nothing than a permanently broken widget.
  function _removeWidget() {
    ['wa-bubble', 'wa-panel', 'wa-transition', 'wa-greeting', 'wa-preview-bubble'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  let session = null;
  let _userProfile = null;    // cached for the lifetime of this page load
  let _pendingGreeting = null; // AI-generated greeting for fresh sessions

  // ─── PROFILE ──────────────────────────────────────────────────────────────

  /**
   * Fetch the authenticated user's profile from the backend.
   * Result is cached in _userProfile and used when building Dialogue context.
   */
  async function loadUserProfile() {
    if (!WA.auth) return null;
    const user = WA.auth.getCurrentUser();
    if (!user?.isAuthenticated) return null;

    const base = 'https://backend.jacob-e87.workers.dev';
    try {
      const clientId = WA.getClientId ? WA.getClientId() : '';
      const profileUrl = `${base}/profile?user_id=${encodeURIComponent(user.id)}${clientId ? `&client_id=${encodeURIComponent(clientId)}` : ''}`;
      const resp = await fetch(profileUrl, {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (!resp.ok) return null;
      const profile = await resp.json();
      // Treat an empty object (no row yet) as null
      _userProfile = profile?.user_id ? profile : null;
      log('Profile loaded:', _userProfile ? JSON.stringify({ name: _userProfile.name, company: _userProfile.company }) : 'none');
      return _userProfile;
    } catch (err) {
      warn('Failed to load profile:', err.message);
      return null;
    }
  }

  /**
   * Save profile fields to the backend for an authenticated user.
   * Safe to call fire-and-forget — errors are swallowed.
   */
  function saveProfileFields(fields) {
    if (!WA.auth) return;
    const user = WA.auth.getCurrentUser();
    if (!user?.isAuthenticated) return;

    const base = 'https://backend.jacob-e87.workers.dev';
    const clientId = WA.getClientId ? WA.getClientId() : '';
    fetch(`${base}/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
      body: JSON.stringify({ user_id: user.id, client_id: clientId, ...fields })
    }).catch(err => warn('saveProfileFields error:', err.message));
  }

  /**
   * Format the loaded profile into a context block for Dialogue.
   * Returns null if no meaningful data is available.
   */
  function buildProfileContext() {
    const p = _userProfile;
    if (!p) return null;

    const lines = ['USER PROFILE:'];

    // Base fields from the profile row
    if (p.name)      lines.push(`  Name: ${p.name}`);
    if (p.company)   lines.push(`  Company: ${p.company}`);
    if (p.job_title) lines.push(`  Role: ${p.job_title}`);
    if (p.phone)     lines.push(`  Phone: ${p.phone}`);

    const authEmail = WA.auth?.getCurrentUser?.()?.email;
    if (authEmail)   lines.push(`  Email: ${authEmail}`);

    if (p.persona_summary) {
      try {
        // Structured JSON persona — render key fields concisely
        const persona = JSON.parse(p.persona_summary);

        const industryParts = [
          persona.business?.industry,
          persona.business?.type,
          persona.business?.size?.locations ? `${persona.business.size.locations} locations` : null
        ].filter(Boolean);
        if (industryParts.length) lines.push(`  Industry: ${industryParts.join(', ')}`);

        if (persona.business?.products_services?.length) {
          lines.push(`  Products/Services: ${persona.business.products_services.join(', ')}`);
        }

        lines.push('');

        if (persona.interests?.length) {
          lines.push(`INTERESTS: ${persona.interests.join(', ')}`);
        }
        if (persona.context?.current_projects?.length) {
          lines.push(`CURRENT PROJECTS: ${persona.context.current_projects.join('; ')}`);
        }
        if (persona.context?.goals?.length) {
          lines.push(`GOALS: ${persona.context.goals.join('; ')}`);
        }
        if (persona.context?.pain_points?.length) {
          lines.push(`PAIN POINTS: ${persona.context.pain_points.join('; ')}`);
        }
        if (persona.engagement_notes?.length) {
          lines.push(`ENGAGEMENT: ${persona.engagement_notes.join('. ')}`);
        }
        if (persona.communication?.style) {
          lines.push(`COMMUNICATION STYLE: ${persona.communication.style}`);
        }
      } catch {
        // Legacy paragraph — render as-is until next webhook call converts it
        lines.push('');
        lines.push('PERSONA NOTES (use to guide tone and rapport):');
        lines.push(`  ${p.persona_summary}`);
      }
    }

    return lines.length > 1 ? lines.join('\n') : null;
  }

  /**
   * Fetch an AI-generated personalised greeting from the backend.
   * Returns null for anonymous users or if the backend has no profile data yet.
   * Stored in _pendingGreeting and consumed once by buildReconnectPrompt().
   */
  async function fetchPersonalisedGreeting() {
    if (!WA.auth) return null;
    const user = WA.auth.getCurrentUser();
    if (!user?.isAuthenticated) return null;
    if (!_userProfile?.name) return null; // no name = can't personalise

    const base = 'https://backend.jacob-e87.workers.dev';
    try {
      const authToken = localStorage.getItem('wa_auth_token');
      const resp = await fetch(`${base}/greeting`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({
          user_id:              user.id,
          page_title:           document.title,
          time_of_day:          (() => {
            const h = new Date().getHours();
            if (h < 12) return 'morning';
            if (h < 17) return 'afternoon';
            if (h < 21) return 'evening';
            return 'night';
          })(),
          last_session_snippet: (() => {
            try {
              const sessions = JSON.parse(localStorage.getItem('wa_past_sessions') || '[]');
              return sessions[0]?.snippet || null;
            } catch { return null; }
          })()
        })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.greeting || null;
    } catch (err) {
      warn('fetchPersonalisedGreeting error:', err.message);
      return null;
    }
  }

  // ─── CONTEXT BUILDERS ─────────────────────────────────────────────────────

  function buildPageContext() {
    const pages = WA.PAGE_MAP || [];
    const forms = WA.FORM_MAP || [];
    const lines = [
      `CURRENT PAGE: ${document.title} (${window.location.href})`,
      // TESTING: pages and form fields temporarily disabled
      // `AVAILABLE PAGES (${pages.length}):`,
      // ...pages.map(p => `  - ${p.label}: ${p.file}`),
    ];
    // if (forms.length) {
    //   lines.push(`CONTACT FORM FIELDS:`);
    //   forms[0]?.fields?.forEach(f => {
    //     lines.push(`  - ${f.label}${f.required ? ' *' : ''} (${f.name})`);
    //   });
    // }

    // Prepend profile block so it appears at the top of the context
    const profileCtx = buildProfileContext();
    if (profileCtx) {
      lines.unshift('');
      lines.unshift(profileCtx);
    }

    // If a greeting was already shown to the user in the chat panel, tell the
    // agent here (as static context) so it doesn't re-greet when it connects.
    // This is intentionally in context rather than sent as a sendUserMessage —
    // sending it as a message triggers a response and causes a double greeting.
    if (_pendingGreeting) {
      lines.push('');
      lines.push(`GREETING ALREADY SHOWN: The user can already see this message in the chat: "${_pendingGreeting}"`);
      lines.push('Do not repeat this greeting or re-introduce yourself. Wait for the user to respond.');
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

    // Fresh session: greeting instruction is already in the context dynamic
    // variable (buildPageContext adds it). Returning null here means no
    // sendUserMessage is fired, so the agent stays quiet and waits for the
    // user — no double greeting.
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
      warn('No agent ID — check backend KV config — removing widget');
      _removeWidget();
      return;
    }

    const btn = document.getElementById('wa-connect-btn');
    if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }

    if (typeof WA.onBridgeConnecting === 'function') WA.onBridgeConnecting();
    setConnectUI('connecting');

    // ✅ LOAD USER PROFILE (authenticated users only — no-op for anonymous)
    await loadUserProfile();

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
    console.log('[WA:Bridge] 📋 CONTEXT SENT TO DIALOGUE:\n', contextToSend);

    try {
      session = await Conversation.startSession({
        agentId: AGENT_ID,

        // ✅ PASS SESSION METADATA
        metadata: {
          session_id: metadata.session_id,
          message_count: metadata.message_count,
          timestamp: new Date().toISOString()
        },

        // ✅ PASS USER_ID AND CONTEXT VIA DYNAMIC VARIABLES
        // user_id       — visitor or authenticated UUID
        // authenticated_user_id — explicitly the authenticated UUID, or null for guests.
        //   This is what the webhook uses to link the call back to authenticated_users.
        //   Keeping it separate avoids any ambiguity with wc_visitor IDs.
        dynamicVariables: {
          user_id: resolvedUserId,
          authenticated_user_id: (() => {
            if (!WA.auth) return null;
            const u = WA.auth.getCurrentUser();
            return u?.isAuthenticated ? u.id : null;
          })(),
          client_id: WA.getClientId ? WA.getClientId() : '',
          context: contextToSend || ''
        },

        onConnect: async function() {
          log('onConnect fired');
          setConnectUI('connected');

          // ✅ CAPTURE DIALOGUE CONVERSATION_ID (with polling)
          // Wait a tick for outer 'session' variable to be assigned
          await new Promise(res => setTimeout(res, 50));
          
          const conversationId = await captureConversationId(session);

          if (conversationId) {
            const waSession = WA.getSession ? WA.getSession() : {};
            waSession.dialogueConversationId = conversationId;
            if (WA.saveSession) WA.saveSession(waSession);
            console.log('[WA:Bridge] ✅ Connected —', conversationId);
          } else {
            // No conversation ID means we cannot reliably track or save this session.
            // Kill it immediately rather than proceeding with orphaned data.
            console.error('[WA:Bridge] ❌ No conversation ID — ending session');
            if (typeof WA.appendMessage === 'function') {
              WA.appendMessage('agent', 'Sorry, something went wrong starting the chat. Please try again in a moment.');
            }
            await disconnect();
            return;
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

          if (userId && waSession.dialogueConversationId && waSession.messages?.length) {
            log('💾 Saving final session...');

            const payload = {
              user_id: userId,
              conversation_id: waSession.dialogueConversationId,
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
          setConnectUI('offline');
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
          setConnectUI('offline');
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
    setConnectUI('offline');
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

  function setConnectUI(status) {
    const label = document.getElementById('wa-status-label');
    if (!label) return;
    const states = {
      connected:  { text: 'Connected',   status: 'connected'  },
      connecting: { text: 'Connecting…', status: 'connecting' },
      offline:    { text: 'Offline',      status: 'offline'    }
    };
    const s = states[status] || states.offline;
    label.textContent    = s.text;
    label.dataset.status = s.status;
  }

  // ─── EXPOSE BRIDGE ────────────────────────────────────────────────────────

  WA.bridge = { connect, disconnect, sendText, skipTurn, isConnected };

  // ─── PERSONALISED GREETING BUBBLE ────────────────────────────────────────
  // Shows a small speech bubble above wa-bubble on page load for authenticated
  // users. Hides when the panel opens, then injects the greeting as the first
  // message in the panel and passes it to Dialogue context.

  (function injectPreviewBubbleCSS() {
    if (document.getElementById('wa-preview-bubble-style')) return;
    const style = document.createElement('style');
    style.id = 'wa-preview-bubble-style';
    style.textContent = `
      #wa-preview-bubble {
        position: fixed;
        bottom: 75px;
        left: 75px;
        background: #fff;
        color: #1f2937;
        font-size: 13px;
        line-height: 1.45;
        max-width: 220px;
        padding: 10px 13px;
        border-radius: 14px 14px 14px 2px;
        box-shadow: 0 3px 14px rgba(0,0,0,0.14);
        z-index: 999999999999;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;
        cursor: default;
      }
      #wa-preview-bubble.wa-preview-visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
    `;
    document.head.appendChild(style);
  })();

  function showPreviewBubble(text) {
    let el = document.getElementById('wa-preview-bubble');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wa-preview-bubble';
      document.body.appendChild(el);
    }
    el.textContent = text;
    // Trigger transition on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('wa-preview-visible'));
    });
    // Auto-dismiss after 10 seconds
    setTimeout(() => hidePreviewBubble(), 10000);
  }

  function hidePreviewBubble() {
    const el = document.getElementById('wa-preview-bubble');
    if (!el) return;
    el.classList.remove('wa-preview-visible');
    setTimeout(() => el.remove(), 350);
  }

  /**
   * Async init: load profile → determine greeting → show bubble.
   * Authenticated users with a profile get an OpenAI-personalised greeting.
   * Guest users fall back to WA_CONFIG.greetingMessage (no OpenAI call).
   * In both cases the bubble shows, the greeting appears as the first panel
   * message, and the Dialogue agent is told not to re-greet.
   */
  async function initPersonalisedGreeting() {
    await loadUserProfile();

    let greeting = null;

    if (_userProfile?.name) {
      // Authenticated user with profile — ask OpenAI for a personalised line
      greeting = await fetchPersonalisedGreeting();
    }

    if (!greeting) {
      // Guest or no profile yet — use the configured default greeting
      greeting = CONFIG.greetingMessage || null;
    }

    if (!greeting) return;

    _pendingGreeting = greeting;

    // Only show the preview bubble on a fresh session (no prior messages)
    const s = WA.getSession ? WA.getSession() : {};
    if (!s.messages?.length) {
      showPreviewBubble(greeting);
    }

    // Patch onPanelOpened: hide bubble + inject greeting as first message
    const _orig = WA.onPanelOpened;
    WA.onPanelOpened = function () {
      hidePreviewBubble();

      const msgs = document.getElementById('wa-messages');
      // Only inject if panel has no messages rendered yet
      if (_pendingGreeting && msgs && !msgs.querySelector('.wa-msg')) {
        WA.appendMessage('agent', _pendingGreeting);
      }

      if (typeof _orig === 'function') _orig.call(this);
    };
  }

  // Fire and forget — doesn't block anything
  initPersonalisedGreeting().catch(err => warn('initPersonalisedGreeting error:', err.message));

  // ─── FORM-FILL PROFILE CAPTURE ────────────────────────────────────────────
  // When an authenticated user submits the contact form, save any name/email/company
  // fields from the completed fill_form action to their profile immediately.
  // This runs before the call-complete webhook fires, so the data is
  // available on the very next session start.
  if (WA.bus) {
    WA.bus.on('form:submitted', () => {
      const s = WA.getSession ? WA.getSession() : {};
      const completedForm = (s.actions || []).find(a => a.type === 'fill_form' && a.status === 'complete');
      if (!completedForm) return;

      const fields = completedForm.payload?.fields || [];
      const extract = (labels) => {
        const f = fields.find(f => labels.some(l => f.label?.toLowerCase().includes(l)));
        return f?.value && !Array.isArray(f.value) ? f.value : null;
      };

      const name    = extract(['name', 'full name']);
      const phone   = extract(['phone', 'tel', 'mobile', 'number']);
      const company = extract(['company', 'organisation', 'organization', 'business']);

      if (name || phone || company) {
        log('Form submitted — saving profile fields:', { name, phone, company });
        saveProfileFields({ name, phone, company });
      }
    });

    WA.bus.emit('bridge:ready');
    log('bridge:ready emitted');
  } else {
    console.error('[WA:Bridge] WA.bus missing — wa-agent.js namespace problem');
    warn('WA.bus not available — wa-agent.js may not have loaded');
    // Still emit bridge:ready on the global so any reconnectBridge() waiters don't hang
    if (window.WebsiteAvatar?.bus) window.WebsiteAvatar.bus.emit('bridge:ready');
  }

})();