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

  // ─── NAVIGATION ───────────────────────────────────────────────────────────

  function navigateTo(url, label) {
    WA.showTransition(label);
    WA.clearQueue();
    WA.disconnectBridge();
    setTimeout(() => { window.location.href = url; }, 400);
  }

  function checkArrival() {
    // Simple navigate
    const navAction = session.actions.find(a => a.type === 'navigate' && a.status === 'active');
    if (navAction) {
      // Mark as complete BEFORE reconnecting so state is ready
      navAction.status      = 'complete';
      navAction.completedAt = Date.now();
      WA.saveSession(session);
      
      // Clear action state so new messages can flow
      WA.setState('action', 'none');
      
      WA.openPanel();
      
      // Reconnect and send arrival prompt
      setTimeout(() => {
        WA.reconnectBridge();
        
        // Wait for connection, then send arrival message
        setTimeout(() => {
          if (WA.bridge && WA.bridge.sendText) {
            const context = WA.PAGE_CONTEXT?.summary || 'this page';
            WA.bridge.sendText(`I've arrived at ${context}.`);
          }
        }, 1000);
      }, 100);
      return;
    }

    // Navigate then fill
    if (!session.pendingOnArrival) return;
    const { page, action } = session.pendingOnArrival;

    const currentPath = window.location.pathname.replace(/\/$/, '');
    const targetPath  = new URL(page, window.location.href).pathname.replace(/\/$/, '');

    if (currentPath !== targetPath) return;

    delete session.pendingOnArrival;
    WA.saveSession(session);
    WA.openPanel();

    setTimeout(async () => {
      const fields = WA.freshFields();
      if (!fields.length) {
        agentSay("I'm here but I couldn't find the contact form. You can fill it in manually.");
        WA.reconnectBridge();
        return;
      }
      action.payload.fields = fields;
      agentSay("We're here! Let's fill out that contact form.");
      const fullAction = WA.createAction('fill_form', action.description, action.payload);
      session.actions.push(fullAction);
      await WA.executeAction(fullAction, session);
    }, 900);
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

  // ─── ACTION CARD RENDERING ────────────────────────────────────────────────

  // ─── CONTEXT FILTERING (INTENT-AWARE) ─────────────────────────────────────

  function normalise(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function scoreElement(el, ctx) {
    let score = 0;
  
    const keywords = (ctx?.keywords || []).map(k => normalise(k));
    const targetSection = normalise(ctx?.section || "");
  
    // Build haystack from section properties
    const keywordString = Array.isArray(el.keywords) ? el.keywords.join(" ") : "";
    const haystack = normalise(
      (el.title || "") + " " +
      (el.summary || "") + " " +
      keywordString + " " +
      (el.type || "")
    );
  
    // console.log('[WA] Scoring:', el.id, 'type:', el.type);
    // console.log('[WA] Target section:', targetSection);
    // console.log('[WA] Keywords:', keywords);
    // console.log('[WA] Haystack sample:', haystack.slice(0, 100));
  
    // Strong match: section type is contained in target
    // e.g., targetSection="hero section" contains el.type="hero"
    if (targetSection && el.type) {
      const normalizedType = normalise(el.type);
      if (targetSection.includes(normalizedType)) {
        score += 30;
        //console.log('[WA] ✅ Type match!', el.type, 'in', targetSection, '+30');
      }
    }
  
    // keyword match in haystack
    keywords.forEach(k => {
      if (haystack.includes(k)) {
        score += 5;
        //console.log('[WA] ✅ Keyword match:', k, '+5');
      }
    });
  
    // title match
    if (targetSection && el.title) {
      const normalizedTitle = normalise(el.title);
      if (normalizedTitle.includes(targetSection) || targetSection.includes(normalizedTitle)) {
        score += 15;
        //console.log('[WA] ✅ Title match:', '+15');
      }
    }
  
    // subsection relevance
    if (el.subsections && Array.isArray(el.subsections)) {
      el.subsections.forEach(sub => {
        const subText = normalise(sub.title + " " + (sub.summary || ""));
        keywords.forEach(k => {
          if (subText.includes(k)) {
            score += 3;
            //console.log('[WA] ✅ Subsection match:', sub.title, k, '+3');
          }
        });
      });
    }
  
    console.log('[WA] Final score:', score);
    return score;
  }

  function filterSubsections(subsections, knowledge) {
    if (!Array.isArray(subsections) || !knowledge) return subsections;

    return subsections
      .map(sub => ({ ...sub, _score: scoreElement(sub, knowledge) }))
      .filter(sub => sub._score > 0)
      .slice(0, 5);
  }

  function filterPageContext(pageContext, knowledge) {
    if (!pageContext?.page?.sections || !knowledge) return pageContext;

    const scored = pageContext.page.sections.map(section => ({
      ...section,
      subsections: filterSubsections(section.subsections, knowledge),
      _score: scoreElement(section, knowledge)
    }));

    const filtered = scored
      .filter(section => section._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 12); // limit size

    return {
      ...pageContext,
      page: {
        ...pageContext.page,
        sections: filtered
      }
    };
  }

  function debugFilteredContext(full, filtered, knowledge) {
    if (!WA.DEBUG) return;
  
    console.group('[WA] 🧠 Context Filtering');
    console.log('Intent:', knowledge?.intent);
    console.log('Keywords:', knowledge?.keywords);
    console.log('Section:', knowledge?.section);
  
    // Get sections from both full and filtered contexts
    const fullSections = full?.page?.sections || [];
    const filteredSections = filtered?.page?.sections || [];
  
    console.group(`📦 FULL (${fullSections.length} sections)`);
    fullSections.forEach(section => {
      console.log(`[${section.type}] ${section.title}`);
      if (section.subsections?.length) {
        console.log(`   └─ ${section.subsections.length} subsections`);
      }
    });
    console.groupEnd();
  
    console.group(`🎯 FILTERED (${filteredSections.length} sections)`);
    filteredSections.forEach(section => {
      const score = section._score !== undefined ? ` (score: ${section._score.toFixed(2)})` : '';
      console.log(`[${section.type}] ${section.title}${score}`);
      console.log(`   keywords: ${section.keywords.slice(0, 5).join(', ')}`);
      
      if (section.subsections?.length) {
        section.subsections.forEach(sub => {
          const subScore = sub._score !== undefined ? ` (${sub._score.toFixed(2)})` : '';
          console.log(`   ↳ ${sub.title}${subScore}`);
        });
      }
    });
    console.groupEnd();
  
    console.groupEnd();
  }

  // ─── AI DECISION ENGINE ───────────────────────────────────────────────────

  async function handleAgentMessage(userMessage, agentMessage, knowledgeContext) {
    // Apply intent-aware filtering
    const filteredContext = filterPageContext(WA.PAGE_CONTEXT, knowledgeContext);
  
    // Debug full vs filtered
    debugFilteredContext(WA.PAGE_CONTEXT, filteredContext, knowledgeContext);
  
    // GATE: Skip OpenAI if filtering did nothing AND there are many sections
    const fullSections = WA.PAGE_CONTEXT?.page?.sections || [];
    const filteredSections = filteredContext?.page?.sections || [];

    if (filteredSections.length === fullSections.length && fullSections.length >= 5) {
      if (WA.DEBUG) console.log('[WA] No filtering applied (0% reduction, >=5 sections) — skipping OpenAI');
      return;
    }
  
    if (typeof WA.showActionChecking === 'function') WA.showActionChecking();
    const result = await WA.decideActions(
      userMessage,
      agentMessage,
      knowledgeContext,
      filteredContext, // Only pass filtered context
      session.messages.slice(-4),
      session.actions
    );
    if (typeof WA.hideActionChecking === 'function') WA.hideActionChecking();

    if (!result || !result.actions?.length) return;
  
    // Double-check still clear
    if (session.actions.some(a => ['pending','active'].includes(a.status))) return;
  
    // Filter out 'none' actions
    const validActions = result.actions.filter(a => a.type && a.type !== 'none');
    if (!validActions.length) return;
  
    // Multiple high-confidence actions → show multi-action card (never auto)
    const highConfidence = validActions.filter(a => (a.confidence || 0.8) >= 0.7);
    if (highConfidence.length > 1) {
      // Force all actions to require confirmation when showing choice card
      const manualActions = highConfidence.map(a => ({ ...a, auto: false }));
      WA.renderMultiActionCard(manualActions);
      return;
    }
  
    // Single action or mixed confidence → execute in sequence
    for (const action of validActions) {
      await executeDecidedAction(action);
      if (validActions.indexOf(action) < validActions.length - 1) {
        await WA.sleep(300);
      }
    }
  }

  async function executeDecidedAction(action) {
    const { type, auto, section_id, subsection_id, element_id, target_url, target_label, reason, confidence } = action;
    const isAuto = auto === true;

    if (type === 'scroll_to') {
      // Try section_id first (new structure), fallback to element_id (old structure)
      const sectionIdToFind = section_id || element_id;

      // Find parent section in PAGE_CONTEXT
      const section = WA.PAGE_CONTEXT?.page?.sections?.find(s => s.id === sectionIdToFind);

      if (!section) {
        console.warn('[WA] Could not find section:', sectionIdToFind);
        return;
      }

      // If a specific subsection was identified, scroll to that instead
      let scrollId = section.id;
      let scrollTitle = section.title;

      if (subsection_id) {
        const sub = section.subsections?.find(s => s.id === subsection_id);
        if (sub) {
          scrollId = sub.id;
          scrollTitle = sub.title;
        } else {
          console.warn('[WA] subsection_id not found in section, falling back to parent:', subsection_id);
        }
      }

      // Use target_label from AI if provided, otherwise fallback to resolved title
      const label = target_label || scrollTitle || scrollId;
      const description = reason || `Show you the ${label} section`;

      WA.proposeAction(session, 'scroll_to', description, {
        sectionId:    scrollId,
        sectionTitle: label,
        elementTitle: scrollTitle || label,  // For backward compatibility
        confidence:   confidence
      }, isAuto !== false); // scroll_to is auto by default
      return;
    }
  
    if (type === 'fill_form') {
      const description = reason || 'Help you fill out the contact form';
      WA.proposeAction(session, 'fill_form', description, { 
        fields: WA.freshFields(),
        confidence: confidence
      }, isAuto);
      return;
    }
  
    if (type === 'navigate_then_fill') {
      const contact = WA.getContactPage();
      if (!contact) return;
      
      const description = reason || `Take you to the ${contact.label} and fill out the enquiry form`;
      const result = await WA.proposeAction(session, 'navigate_then_fill',
        description,
        {
          targetPage:          contact.file,
          targetLabel:         target_label || contact.label,
          nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } },
          confidence:          confidence
        },
        isAuto
      );
      return result;
    }
  
    if (type === 'navigate' && target_url) {
      const targetClean  = target_url.replace(/\/$/, '');
      const currentClean = window.location.href.replace(/\/$/, '');
      if (targetClean === currentClean) return;
  
      const page    = WA.getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
      const label   = target_label || (page ? page.label : 'page');
      const contact = WA.getContactPage();
  
      if (contact && targetClean === contact.file.replace(/\/$/, '')) {
        WA.proposeChoiceAction(session,
          `Would you like to just visit the ${label}, or go there and fill out the enquiry form?`,
          [
            { label: 'Just browse',   action: { type: 'navigate',           description: `Take you to the ${label}.`,                payload: { targetPage: contact.file, targetLabel: label } } },
            { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } } } } }
          ]
        );
      } else {
        const description = reason || `Take you to the ${label}`;
        const result = await WA.proposeAction(session, 'navigate', description, { 
          targetPage: target_url, 
          targetLabel: label,
          confidence: confidence
        }, isAuto);
        return result;
      }
      return;
    }
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
    const hasNavAction     = session.actions.some(a => a.type === 'navigate' && a.status === 'active');
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
    if (session.activeFormActionId && !session.pendingOnArrival) {
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
    checkArrival();

    // Auto-connect if session active
    if (hasActiveSession && !hasNavAction && !hasFormResume) {
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
  WA.navigateTo           = navigateTo;
  WA.endSession           = endSession;
  WA.executeDecidedAction = executeDecidedAction;
  WA.handleAgentMessage   = handleAgentMessage;
  WA._lastUserMessage     = '';

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