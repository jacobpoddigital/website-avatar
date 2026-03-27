/**
 * features/actions.js — Action System
 * Action registry, all action handlers, execution orchestration
 * Reads page context, emits state changes, calls UI functions
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  // ─── ACTION REGISTRY ──────────────────────────────────────────────────────

  const ActionRegistry = {};

  function registerAction(def) {
    ActionRegistry[def.type] = def;
    if (WA.DEBUG) console.log(`[WA] Action registered: ${def.type}`);
  }

  async function executeAction(action, session) {
    const handler = ActionRegistry[action.type];
    if (!handler) {
      console.warn(`[WA] No handler for action type: ${action.type}`);
      if (WA.agentSay) WA.agentSay("I don't know how to do that yet — I'll let the team know.");
      if (WA.setState) WA.setState('action', 'error');
      return;
    }

    if (WA.setState) WA.setState('action', 'active');
    action.status    = 'active';
    action.startedAt = Date.now();
    if (WA.saveSession) WA.saveSession(session);
    if (WA.updateAbortButton) WA.updateAbortButton(true);

    try {
      await handler.execute(action, session);
      action.status      = 'complete';
      action.completedAt = Date.now();
      if (WA.saveSession) WA.saveSession(session);
      if (WA.setState) WA.setState('action', 'complete');
      if (WA.updateAbortButton) WA.updateAbortButton(false);
      if (handler.onComplete) await handler.onComplete(action);
    } catch (err) {
      console.warn(`[WA] Action ${action.type} failed:`, err);
      action.status      = 'failed';
      action.error       = { message: err.message, retryable: !!err.retryable };
      action.completedAt = Date.now();
      if (WA.saveSession) WA.saveSession(session);
      if (WA.setState) WA.setState('action', 'error');
      if (WA.updateAbortButton) WA.updateAbortButton(false);
      if (handler.onError) {
        await handler.onError(err, action);
      } else {
        if (WA.agentSay) WA.agentSay("Something went wrong — please try again or complete this manually.");
      }
    }
  }

  // ─── ACTION HANDLERS ──────────────────────────────────────────────────────

  // NAVIGATE
  registerAction({
    type:            'navigate',
    label:           'Navigate to page',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { targetPage, targetLabel } = action.payload;
      if (WA.agentSay) WA.agentSay(`Navigating you to the ${targetLabel}…`);
      await WA.sleep(800);
      if (WA.navigateTo) WA.navigateTo(targetPage, targetLabel);
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {
      // Reconnect happens in checkArrival() on new page
    }
  });

  // FILL FORM
  registerAction({
    type:            'fill_form',
    label:           'Fill contact form',
    permissionLevel: 'propose',

    execute: async (action) => {
      return new Promise(resolve => {
        action._resolveFormFill = resolve;
        if (WA.startFormFill) WA.startFormFill(action);
      });
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay("I had trouble filling the form. You can complete it manually — all the fields are visible.");
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async (action) => {
      setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 1000);
    }
  });

  // NAVIGATE THEN FILL
  registerAction({
    type:            'navigate_then_fill',
    label:           'Go to contact page and fill form',
    permissionLevel: 'propose',

    execute: async (action, session) => {
      const { targetPage, targetLabel, nextActionOnArrival } = action.payload;
      if (WA.agentSay) WA.agentSay(`I'll take you to the ${targetLabel} and we'll fill out the form together.`);
      session.pendingOnArrival = { page: targetPage, action: nextActionOnArrival };
      if (WA.saveSession) WA.saveSession(session);
      await WA.sleep(1000);
      if (WA.navigateTo) WA.navigateTo(targetPage, targetLabel);
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {}
  });

  // CLICK ELEMENT
  registerAction({
    type:            'click_element',
    label:           'Click page element',
    permissionLevel: 'propose',

    execute: async (action) => {
      const { elementId, elementText } = action.payload;
      const ctx = WA.PAGE_CONTEXT;
      const el  = ctx?._refs?.[elementId];
      if (!el) throw new Error(`Element ${elementId} not found`);
      if (WA.agentSay) WA.agentSay(`Clicking "${elementText}" for you…`);
      await WA.sleep(400);
      el.click();
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't click that — you can click "${action.payload.elementText}" yourself.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 800);
    }
  });

  // SCROLL TO (with sparkle highlight effect)
  registerAction({
    type:            'scroll_to',
    label:           'Scroll to section',
    permissionLevel: 'auto',

    execute: async (action) => {
      const { elementId, elementTitle } = action.payload;
      const ctx = WA.PAGE_CONTEXT;
      const el  = ctx?._refs?.[elementId];
      if (!el) throw new Error(`Section ${elementId} not found`);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await WA.sleep(600);
      if (WA.spawnSparkles) WA.spawnSparkles(el);
      if (WA.agentSay) WA.agentSay(`Here's the ${elementTitle}.`);

      // Skip turn - prevent disconnect during scroll
      if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
    },

    onError: async (err, action) => {
      if (WA.agentSay) WA.agentSay(`I couldn't scroll there — try scrolling down manually.`);
      if (WA.reconnectBridge) WA.reconnectBridge();
    },

    onComplete: async () => {
      setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 600);
    }
  });

  // ─── URL VALIDATION ───────────────────────────────────────────────────────

  async function validateUrl(url) {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ─── ACTION ORCHESTRATION ─────────────────────────────────────────────────

  function createAction(type, description, payload) {
    const action = {
      id:          'act_' + Date.now(),
      type,
      description,
      payload,
      status:      'pending',
      createdAt:   Date.now(),
      startedAt:   null,
      completedAt: null,
      error:       null
    };
    return action;
  }

  async function proposeAction(session, type, description, payload, autoOverride) {
    // Guard — only one pending/active at a time
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) {
      if (WA.DEBUG) console.log('[WA] Action already pending/active — skipping proposal');
      return;
    }

    const handler = ActionRegistry[type];

    // For navigate actions, validate URL first
    if (type === 'navigate' && payload?.targetPage) {
      const isValid = await validateUrl(payload.targetPage);
      if (!isValid) {
        if (WA.DEBUG) console.warn(`[WA] Skipping action — target URL not valid: ${payload.targetPage}`);
        return; // Skip proposing this action
      }
    }

    const action  = createAction(type, description, payload);
    session.actions.push(action);
    if (WA.saveSession) WA.saveSession(session);

    const isAuto = autoOverride === true || handler?.permissionLevel === 'auto';

    if (isAuto) {
      if (WA.DEBUG) console.log(`[WA] Auto-executing: ${type}`);
      if (WA.setState) WA.setState('action', 'active');
      action.status    = 'active';
      action.startedAt = Date.now();
      if (WA.saveSession) WA.saveSession(session);

      // Skip turn instead of disconnect - stay connected during action
      if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
      executeAction(action, session);
      return;
    }

    if (WA.setState) WA.setState('action', 'proposed');
    if (WA.renderActionCard) WA.renderActionCard(action);
  }

  function proposeChoiceAction(session, description, options) {
    const hasActive = session.actions.some(a => ['pending','active'].includes(a.status));
    if (hasActive) return;

    if (WA.renderCard) {
      WA.renderCard({
        label:   'Choose an action',
        message: description,
        buttons: options.map((opt) => ({
          text:   opt.label,
          style:  'confirm',
          action: () => {
            const a = createAction(opt.action.type, opt.action.description, opt.action.payload);
            session.actions.push(a);
            a.status    = 'active';
            a.startedAt = Date.now();
            if (WA.saveSession) WA.saveSession(session);

            // Skip turn instead of disconnect - stay connected during action
            if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
            executeAction(a, session);
          }
        })).concat([{ text: 'No thanks', style: 'deny', action: () => { if (WA.setState) WA.setState('action', 'none'); } }])
      });
    }
  }

  function confirmAction(actionId, session) {
    const action = session.actions.find(a => a.id === actionId);
    if (!action || action.status !== 'pending') return;
    if (WA.setState) WA.setState('action', 'active');
    if (WA.updateActionCardStatus) WA.updateActionCardStatus(actionId, 'active');

    // Skip turn instead of disconnect - stay connected during action
    if (WA.bridge?.skipTurn) WA.bridge.skipTurn();
    executeAction(action, session);
  }

  function denyAction(actionId, session) {
    const action = session.actions.find(a => a.id === actionId);
    if (!action || action.status !== 'pending') return;
    action.status      = 'denied';
    action.completedAt = Date.now();
    if (WA.saveSession) WA.saveSession(session);
    if (WA.updateActionCardStatus) WA.updateActionCardStatus(actionId, 'denied');
    const hasOtherActive = session.actions.some(a => a.id !== actionId && a.status === 'active');
    if (!hasOtherActive && WA.setState) WA.setState('action', 'none');
    if (WA.agentSay) WA.agentSay("No problem — just let me know if you change your mind.");
  }

  function dismissPendingActions(session) {
    session.actions.forEach(a => {
      if (a.status === 'pending') {
        a.status      = 'denied';
        a.completedAt = Date.now();
        const card = document.querySelector(`[data-action-id="${a.id}"]`);
        if (card) card.style.display = 'none';
      }
    });
    if (WA.saveSession) WA.saveSession(session);
    const hasActive = session.actions.some(a => a.status === 'active');
    if (!hasActive && WA.setState) WA.setState('action', 'none');
  }

  function abortCurrentAction(session) {
    const activeAction = session.actions.find(a => a.status === 'active');
    if (!activeAction) return;

    if (WA.formState?.active && WA.abandonFormFill) {
      WA.abandonFormFill();
      return;
    }

    activeAction.status      = 'denied';
    activeAction.completedAt = Date.now();
    if (WA.saveSession) WA.saveSession(session);
    if (WA.setState) WA.setState('action', 'none');
    if (WA.updateAbortButton) WA.updateAbortButton(false);
    if (WA.agentSay) WA.agentSay("Action cancelled. What would you like to do?");
    setTimeout(() => { if (WA.reconnectBridge) WA.reconnectBridge(); }, 600);
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.ActionRegistry        = ActionRegistry;
  WA.registerAction        = registerAction;
  WA.executeAction         = executeAction;
  WA.createAction          = createAction;
  WA.proposeAction         = proposeAction;
  WA.proposeChoiceAction   = proposeChoiceAction;
  WA.confirmAction         = confirmAction;
  WA.denyAction            = denyAction;
  WA.dismissPendingActions = dismissPendingActions;
  WA.abortCurrentAction    = abortCurrentAction;

})();