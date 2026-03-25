/**
 * wa-decision.js — Action decision engine with least-friction-path logic
 * Prioritizes: 1) Current page actions, 2) Choice between options, 3) Navigation
 * Implements smart form detection and content availability checking.
 */

(function () {

    const WA = window.WebsiteAvatar;
    if (!WA) { console.error('[WA:Decision] Core not loaded'); return; }
  
    let decideController = null;
  
    // Skip these generic phrases — nothing actionable
    const SKIP_PHRASES = [
      'are you still there', 'still there', "you're not responding",
      'gotten distracted', 'stepped away', 'seems like you',
      'how can i help', 'what can i help', 'what would you like',
      'is there anything', 'anything else i can help',
      'let me know if', 'feel free to ask'
    ];
  
    // ─── MAIN DECISION FUNCTION ───────────────────────────────────────────────
    WA.decideActions = async function(userMessage, agentMessage) {
      const lower = agentMessage.toLowerCase();
  
      // Skip inactivity / generic phrases
      if (SKIP_PHRASES.some(p => lower.includes(p))) {
        WA.log('Action decision skipped — generic phrase');
        return;
      }
  
      // Don't overlap with active actions
      if (WA.session.actions.some(a => ['pending','active'].includes(a.status))) {
        WA.log('Action decision skipped — action already active');
        return;
      }
  
      // Cancel any in-flight request
      if (decideController) decideController.abort();
      decideController = new AbortController();
  
      const prompt = buildClassifyPrompt(agentMessage);
      const t0 = Date.now();
      WA.log('→ Action decision request sent');
  
      try {
        const res = await fetch(WA.OPENAI_PROXY, {
          method:  'POST',
          signal:  decideController.signal,
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ prompt, maxTokens: 200 })
        });
  
        if (!res.ok) { WA.warn('Action decision error:', res.status); return; }
  
        const data = await res.json();
        const raw  = data.content || '';
        WA.log(`← Action decision ${Date.now() - t0}ms:`, raw.trim());
  
        let parsed;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch(e) { WA.warn('Bad JSON from action decision:', raw); return; }
  
        if (!parsed.actions?.length) return;
  
        // Double-check still clear before executing
        if (WA.session.actions.some(a => ['pending','active'].includes(a.status))) return;
  
        for (const action of parsed.actions) {
          if (!action.type || action.type === 'none') continue;
          await executeDecidedAction(action);
          if (parsed.actions.indexOf(action) < parsed.actions.length - 1) {
            await WA.sleep(300);
          }
        }
  
      } catch(e) {
        if (e.name === 'AbortError') {
          WA.log('Action decision cancelled — superseded');
        } else {
          WA.warn('Action decision failed:', e.message);
        }
      }
    };
  
    // ─── BUILD COMPRESSED PROMPT ──────────────────────────────────────────────
    function buildClassifyPrompt(agentMessage) {
      const domain = window.location.origin;
      const pages  = WA.getPageMap().map(p => {
        const path = p.file.replace(domain, '');
        return `${p.label}|${path}`;
      }).join('\n');
      const currentUrl = window.location.href;
      const ctx        = WA.PAGE_CONTEXT;
  
      const pageEls = ctx?.elements?.length
        ? ctx.elements.map(e => {
            const shortId = e.id.replace('wa_el_', '');
            const shortActions = e.actions.map(a => a[0]).join(',');
            return `${shortId}|${e.type}|${e.text || e.title || e.number || e.email || ''}|${shortActions}`;
          }).join('\n')
        : 'none';
  
      const recentMsgs = WA.session.messages.slice(-4)
        .map(m => `${m.role === 'user' ? 'U' : 'M'}: ${m.text}`)
        .join('\n');
  
      return `You are deciding what actions a website chat widget should take after the agent spoke.
  
  CURRENT PAGE: ${document.title}
  URL: ${currentUrl}
  
  AVAILABLE PAGES (label|url):
  ${pages}
  
  PAGE ELEMENTS (id|type|text/title|actions):
  ${pageEls}
  
  RECENT CONVERSATION:
  ${recentMsgs}
  
  AGENT JUST SAID: "${agentMessage}"
  
  Reply with JSON only:
  {
    "actions": [
      {
        "type": "scroll_to"|"navigate"|"fill_form"|"navigate_then_fill"|"click_element"|"choice"|"none",
        "auto": true|false,
        "element_id": "N or null",
        "target_url": "exact url from pages list or null",
        "reason": "brief reason",
        "choice_options": [
          {"label": "option text", "action": {...}},
          {"label": "option text", "action": {...}}
        ]
      }
    ]
  }
  
  RULES:
  - Empty [] if no action needed
  - auto:true = execute now (scroll_to only)
  - auto:false = confirm first (navigate, fill_form, click_element, choice)
  - element_id uses compressed format (5 not wa_el_5)
  - Max 2 actions
  
  CRITICAL LEAST-FRICTION-PATH LOGIC:
  1. FORMS: If user wants to contact/enquire and there's a form on THIS page, use fill_form (scroll to footer form). Only use navigate_then_fill if NO form exists on current page.
  2. CONTENT CHOICE: If content exists both on current page (as section) AND on dedicated page, return type:"choice" with choice_options containing both scroll_to and navigate actions. Let user decide.
  3. NAVIGATION ONLY: If content ONLY exists on another page, use navigate.
  4. Never navigate to the current page.`;
    }
  
    // ─── EXECUTE DECIDED ACTION ───────────────────────────────────────────────
    async function executeDecidedAction(action) {
      const { type, auto, element_id, target_url, choice_options } = action;
      const isAuto = auto === true;
  
      // ── CHOICE — offer multiple options ──────────────────────────────────────
      if (type === 'choice' && choice_options?.length >= 2) {
        const formattedOptions = choice_options.map(opt => ({
          label:  opt.label,
          action: opt.action
        }));
        WA.proposeChoiceAction('What would you prefer?', formattedOptions);
        return;
      }
  
      // ── SCROLL TO ────────────────────────────────────────────────────────────
      if (type === 'scroll_to') {
        const expandedId = element_id?.startsWith('wa_el_') ? element_id : `wa_el_${element_id}`;
        const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
        if (!el) return;
        const label = el.text || el.title || el.number || el.email || element_id;
        WA.proposeAction(type, label, {
          elementId:    el.id,
          elementText:  label,
          elementTitle: el.title || el.text || label
        }, isAuto !== false); // default to auto
        return;
      }
  
      // ── FILL FORM ────────────────────────────────────────────────────────────
      if (type === 'fill_form') {
        WA.proposeAction('fill_form', 'Help you fill out the contact form.', { fields: WA.freshFields() }, isAuto);
        return;
      }
  
      // ── NAVIGATE THEN FILL ───────────────────────────────────────────────────
      if (type === 'navigate_then_fill') {
        const contact = WA.getContactPage();
        if (!contact) return;
        WA.proposeAction('navigate_then_fill',
          `Take you to the ${contact.label} and fill out the enquiry form.`,
          {
            targetPage:          contact.file,
            targetLabel:         contact.label,
            nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } }
          },
          isAuto
        );
        return;
      }
  
      // ── NAVIGATE ─────────────────────────────────────────────────────────────
      if (type === 'navigate' && target_url) {
        const targetClean  = target_url.replace(/\/$/, '');
        const currentClean = window.location.href.replace(/\/$/, '');
        if (targetClean === currentClean) return;
  
        const page    = WA.getPageMap().find(p => p.file.replace(/\/$/, '') === targetClean);
        const label   = page ? page.label : 'page';
        const contact = WA.getContactPage();
  
        // Special case: contact page navigation — offer browse vs fill
        if (contact && targetClean === contact.file.replace(/\/$/, '')) {
          WA.proposeChoiceAction(
            `Would you like to just visit the ${contact.label}, or go there and fill out the enquiry form?`,
            [
              { label: 'Just browse',   action: { type: 'navigate',           description: `Take you to the ${contact.label}.`,                payload: { targetPage: contact.file, targetLabel: contact.label } } },
              { label: 'Fill the form', action: { type: 'navigate_then_fill', description: `Take you to the ${contact.label} and fill the form.`, payload: { targetPage: contact.file, targetLabel: contact.label, nextActionOnArrival: { type: 'fill_form', description: 'Fill out the contact form.', payload: { fields: [] } } } } }
            ]
          );
        } else {
          WA.proposeAction('navigate', `Take you to the ${label}.`, { targetPage: target_url, targetLabel: label }, isAuto);
        }
        return;
      }
  
      // ── CLICK ELEMENT ────────────────────────────────────────────────────────
      if (type === 'click_element' && element_id) {
        const expandedId = element_id?.startsWith('wa_el_') ? element_id : `wa_el_${element_id}`;
        const el = WA.PAGE_CONTEXT?.elements?.find(e => e.id === expandedId);
        if (!el) return;
        WA.proposeAction('click_element',
          `Click "${el.text || el.title}" for you.`,
          { elementId: el.id, elementText: el.text || el.title },
          isAuto
        );
      }
    }
  
    WA.bus.emit('decision:ready');
    WA.log('Decision module loaded');
  
  })();