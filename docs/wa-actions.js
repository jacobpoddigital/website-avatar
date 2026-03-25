/**
 * wa-actions.js — Action registry and handlers
 * Navigation, scroll, highlight, click, form actions.
 */

(function () {

    const WA = window.WebsiteAvatar;
    if (!WA) { console.error('[WA:Actions] Core not loaded'); return; }
  
    WA.ActionRegistry = {};
  
    // ─── REGISTRATION ─────────────────────────────────────────────────────────
    WA.registerAction = function(def) {
      WA.ActionRegistry[def.type] = def;
      WA.log(`Action registered: ${def.type}`);
    };
  
    WA.executeAction = async function(action) {
      const handler = WA.ActionRegistry[action.type];
      if (!handler) {
        WA.warn(`No handler for action type: ${action.type}`);
        WA.agentSay("I don't know how to do that yet — I'll let the team know.");
        WA.setState('action', 'error');
        return;
      }
  
      WA.setState('action', 'active');
      action.status    = 'active';
      action.startedAt = Date.now();
      WA.saveSession();
      WA.updateAbortButton();
  
      try {
        await handler.execute(action);
        action.status      = 'complete';
        action.completedAt = Date.now();
        WA.saveSession();
        WA.setState('action', 'complete');
        WA.updateAbortButton();
        if (handler.onComplete) await handler.onComplete(action);
      } catch (err) {
        WA.warn(`Action ${action.type} failed:`, err);
        action.status      = 'failed';
        action.error       = { message: err.message, retryable: !!err.retryable };
        action.completedAt = Date.now();
        WA.saveSession();
        WA.setState('action', 'error');
        WA.updateAbortButton();
        if (handler.onError) {
          await handler.onError(err, action);
        } else {
          WA.agentSay("Something went wrong — please try again or complete this manually.");
        }
      }
    };
  
    // ─── NAVIGATE ─────────────────────────────────────────────────────────────
    WA.registerAction({
      type:            'navigate',
      label:           'Navigate to page',
      permissionLevel: 'propose',
  
      execute: async (action) => {
        const { targetPage, targetLabel } = action.payload;
        WA.agentSay(`Navigating you to the ${targetLabel}…`);
        await WA.sleep(800);
        WA.navigateTo(targetPage, targetLabel);
      },
  
      onError: async (err, action) => {
        WA.agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
        WA.reconnectBridge();
      }
    });
  
    // ─── SCROLL TO ────────────────────────────────────────────────────────────
    WA.registerAction({
      type:            'scroll_to',
      label:           'Scroll to section',
      permissionLevel: 'auto',
  
      execute: async (action) => {
        const el = document.getElementById(action.payload.elementId);
        if (!el) throw new Error('Element not found');
        
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await WA.sleep(800);
        
        // Highlight after scroll
        el.classList.add('wa-highlight');
        setTimeout(() => el.classList.remove('wa-highlight'), 2500);
      },
  
      onError: async () => {
        WA.agentSay("I couldn't scroll to that section — it might not be visible right now.");
      },
  
      onComplete: async () => {
        setTimeout(() => WA.reconnectBridge(), 1000);
      }
    });
  
    // ─── HIGHLIGHT ELEMENT ────────────────────────────────────────────────────
    WA.registerAction({
      type:            'highlight_element',
      label:           'Highlight element',
      permissionLevel: 'auto',
  
      execute: async (action) => {
        const el = document.getElementById(action.payload.elementId);
        if (!el) throw new Error('Element not found');
        
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await WA.sleep(500);
        el.classList.add('wa-highlight');
        setTimeout(() => el.classList.remove('wa-highlight'), 3000);
      },
  
      onComplete: async () => {
        setTimeout(() => WA.reconnectBridge(), 1200);
      }
    });
  
    // ─── CLICK ELEMENT ────────────────────────────────────────────────────────
    WA.registerAction({
      type:            'click_element',
      label:           'Click element',
      permissionLevel: 'propose',
  
      execute: async (action) => {
        const el = document.getElementById(action.payload.elementId);
        if (!el) throw new Error('Element not found');
        
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await WA.sleep(600);
        el.click();
      },
  
      onError: async () => {
        WA.agentSay("I had trouble clicking that — please try clicking it yourself.");
      },
  
      onComplete: async () => {
        setTimeout(() => WA.reconnectBridge(), 1000);
      }
    });
  
    // ─── FILL FORM ────────────────────────────────────────────────────────────
    WA.registerAction({
      type:            'fill_form',
      label:           'Fill contact form',
      permissionLevel: 'propose',
  
      execute: async (action) => {
        // Returns a Promise that resolves only after user submits or cancels
        await new Promise(resolve => {
          action._resolveFormFill = resolve;
          WA.startFormFill(action);
        });
      },
  
      onError: async (err, action) => {
        WA.agentSay("I had trouble filling the form. You can complete it manually — all the fields are visible.");
        WA.reconnectBridge();
      },
  
      onComplete: async (action) => {
        setTimeout(() => WA.reconnectBridge(), 1000);
      }
    });
  
    // ─── NAVIGATE THEN FILL ───────────────────────────────────────────────────
    WA.registerAction({
      type:            'navigate_then_fill',
      label:           'Go to contact page and fill form',
      permissionLevel: 'propose',
  
      execute: async (action) => {
        const { targetPage, targetLabel } = action.payload;
        WA.agentSay(`Taking you to the ${targetLabel} to fill out the form…`);
        await WA.sleep(800);
        WA.navigateTo(targetPage, targetLabel);
      },
  
      onError: async (err, action) => {
        WA.agentSay(`I couldn't navigate to ${action.payload.targetLabel}. You can find it in the menu.`);
        WA.reconnectBridge();
      }
    });
  
    WA.bus.emit('actions:ready');
    WA.log('Actions module loaded');
  
  })();