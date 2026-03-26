/**
 * core/ai.js — OpenAI Integration
 * Form fill AI conversation + action decision engine
 * Pure async functions - return data, don't mutate global state directly
 */

(function () {

    const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
    const CONFIG = window.WA_CONFIG || {};
    const OPENAI_PROXY = CONFIG.openaiProxyUrl || 'https://backend.jacob-e87.workers.dev/classify';
  
    // Module-level controllers for cancellation
    let formAIController = null;
    let decideController = null;
  
    // ─── FORM AI ──────────────────────────────────────────────────────────────
  
    const SKIP_PHRASES = [
      'are you still there', 'still there', "you're not responding",
      'gotten distracted', 'stepped away', 'seems like you',
      'how can i help', 'what can i help', 'what would you like',
      'is there anything', 'anything else i can help',
      'let me know if', 'feel free to ask'
    ];
  
    async function handleFormInputAI(userText, fields, recentMessages) {
      // Cancel any in-flight request
      if (formAIController) formAIController.abort();
      formAIController = new AbortController();
  
      const isResume = userText === '__RESUME__';
  
      // Build field summary
      const fieldSummary = fields.map((f, idx) => {
        const val  = f.value
          ? (Array.isArray(f.value) ? f.value.join(', ') : '"' + f.value + '"')
          : 'empty';
        const opts = f.options?.length
          ? ` | options: [${f.options.map(o => o.value).join(', ')}]`
          : '';
        const multi = f.type === 'checkbox' ? ' | multi-select' : (f.type === 'radio' ? ' | single-select' : '');
        const typeHint = ['checkbox','radio','select'].includes(f.type)
          ? ` ⚠️ USE show_options action for this field`
          : '';
        return `${idx + 1}. ${f.label} (name: ${f.name}, type: ${f.type}${f.required ? ', required' : ', optional'}${multi}${opts}): ${val}${typeHint}`;
      }).join('\n');
  
      const recentMsgs = recentMessages.map(m =>
        `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`
      ).join('\n');
  
      const prompt = `You are managing a form fill conversation for a website contact form.
  
  FORM FIELDS (name | type | required | current value):
  ${fieldSummary}
  
  RECENT CONVERSATION:
  ${recentMsgs}
  
  USER JUST SAID: "${isResume ? '(continuing form fill — do NOT greet again, just ask for the next empty required field in sequence)' : userText}"
  
  Reply with JSON only, no explanation:
  {
    "action": "fill_field" | "correct_field" | "show_options" | "submit_ready" | "abort" | "ask_again",
    "field_name": "name attribute of field to update, or null",
    "value": "value to set for fill_field/correct_field, or null",
    "options": ["option1", "option2"] | null,
    "multi": true | false,
    "message": "what to say to the user",
    "all_required_filled": true | false
  }
  
  Rules:
  - abort: user wants to stop, cancel, or leave (any phrasing)
  - fill_field: user provided a value for a plain text/email/tel/textarea field
  - correct_field: user is correcting a previously filled field
  - show_options: field is type checkbox, radio, or select — render options as buttons for user to pick
  - submit_ready: all required fields are filled
  - ask_again: input was unclear or ambiguous
  - IMPORTANT: Ask for fields strictly in the numbered order listed above — never skip or reorder
  - After filling a field, confirm and ask for the NEXT field in sequence by number
  - For checkbox/radio/select fields: always return show_options — never ask user to type their choice
  - For show_options include field_name and all options from the field definition
  - If all required fields are now filled, set action to submit_ready and all_required_filled to true
  - Never ask for a field that already has a value unless user is correcting it
  - Validate email format, phone must have at least 7 digits — if invalid ask user to correct it`;
  
      if (WA.DEBUG) console.log('[WA] → Form AI request sent');
      const t0 = Date.now();
  
      try {
        const res = await fetch(OPENAI_PROXY, {
          method:  'POST',
          signal:  formAIController.signal,
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ prompt, maxTokens: 250 })
        });
  
        if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
  
        const data = await res.json();
        const raw  = data.content || '';
        if (WA.DEBUG) console.log(`[WA] ← Form AI ${Date.now() - t0}ms:`, raw.trim());
  
        let parsed;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch(e) {
          console.warn('[WA] Form AI bad JSON:', raw);
          return { error: 'parse_failed', message: "Sorry, I didn't catch that — could you say it again?" };
        }
  
        return parsed;
  
      } catch(e) {
        if (e.name === 'AbortError') {
          if (WA.DEBUG) console.log('[WA] Form AI cancelled');
          return { error: 'cancelled' };
        }
        console.warn('[WA] Form AI error:', e.message);
        return { error: 'network', message: "I'm having trouble processing that — could you try again?" };
      }
    }
  
    // ─── ACTION DECISION ENGINE ───────────────────────────────────────────────
  
    async function decideActions(userMessage, agentMessage, knowledgeContext, pageContext, recentMessages, actions) {
      const lower = agentMessage.toLowerCase();
  
      // Skip generic phrases
      if (SKIP_PHRASES.some(p => lower.includes(p))) {
        if (WA.DEBUG) console.log('[WA] Action decision skipped — generic phrase');
        return null;
      }
  
      // Don't overlap with active actions
      if (actions.some(a => ['pending','active'].includes(a.status))) {
        if (WA.DEBUG) console.log('[WA] Action decision skipped — action already active');
        return null;
      }
  
      // Cancel any in-flight request
      if (decideController) decideController.abort();
      decideController = new AbortController();
  
      const domain = window.location.origin;
      const pages  = WA.getPageMap().map(p => {
        const path = p.file.replace(domain, '');
        return `${p.label}|${path}`;
      }).join('\n');
  
      const currentUrl = window.location.pathname;  // Just the path, e.g. /contact/
      const ctx        = pageContext;
  
      const pageEls = ctx?.elements?.length
        ? ctx.elements.map(e => {
            const shortId = e.id.replace('wa_el_', '');
            const shortActions = e.actions.map(a => a[0]).join(',');
            return `${shortId}|${e.type}|${e.text || e.title || e.number || e.email || ''}|${shortActions}`;
          }).join('\n')
        : 'none';
  
      const recentMsgs = recentMessages.map(m => `${m.role === 'user' ? 'U' : 'M'}: ${m.text}`).join('\n');
  
      // Add knowledge context if available
      const knowledgeSection = knowledgeContext ? `
  KNOWLEDGE CONTEXT (from agent's response):
  Intent: ${knowledgeContext.intent || 'unknown'}
  Target page: ${knowledgeContext.target_page || 'current page'}
  Section: ${knowledgeContext.section || 'not specified'}
  Confidence: ${knowledgeContext.confidence}
  Keywords: ${knowledgeContext.keywords?.join(', ') || 'none'}
  Matched text: "${knowledgeContext.matched_text?.slice(0, 100) || ''}..."
  
  This context shows what the agent knows about the user's intent. Use it to decide the most appropriate action.
  ` : '';
  
      const prompt = `You are deciding what actions a website chat widget should take after the agent spoke.
  
  CURRENT PAGE: ${document.title}
  URL: ${currentUrl}
  
  AVAILABLE PAGES (label|url):
  ${pages}
  
  PAGE ELEMENTS (id|type|text/title|actions):
  ${pageEls}
  
  RECENT CONVERSATION:
  ${recentMsgs}
  
  AGENT JUST SAID: "${agentMessage}"
  
  ${knowledgeSection}
  
  Reply with JSON only:
  {
    "actions": [
      {
        "type": "scroll_to"|"navigate"|"fill_form"|"navigate_then_fill"|"click_element"|"none",
        "auto": true|false,
        "element_id": "N or null",
        "target_url": "exact url from pages list or null",
        "reason": "brief reason"
      }
    ]
  }
  
  RULES:
  - Empty [] if no action needed
  - auto:true = execute now (scroll_to automatically)
  - auto:false = confirm first (navigate, fill_form, click_element)
  - element_id uses compressed format (5 not wa_el_5)
  - If target_page matches current URL (both are paths), use scroll_to. If different, use navigate.
  - Use scroll_to only when already on the target page
  - Max 2 actions`;
  
      const t0 = Date.now();
      if (WA.DEBUG) console.log('[WA] → Action decision request sent');
  
      try {
        const res = await fetch(OPENAI_PROXY, {
          method:  'POST',
          signal:  decideController.signal,
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ prompt, maxTokens: 200 })
        });
  
        if (!res.ok) { 
          console.warn('[WA] Action decision error:', res.status);
          return null;
        }
  
        const data = await res.json();
        const raw  = data.content || '';
        if (WA.DEBUG) console.log(`[WA] ← Action decision ${Date.now() - t0}ms:`, raw.trim());
  
        let parsed;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch(e) {
          console.warn('[WA] Bad JSON from action decision:', raw);
          return null;
        }
  
        return parsed;
  
      } catch(e) {
        if (e.name === 'AbortError') {
          if (WA.DEBUG) console.log('[WA] Action decision cancelled — superseded');
        } else {
          console.warn('[WA] Action decision failed:', e.message);
        }
        return null;
      }
    }
  
    // ─── EXPOSE ───────────────────────────────────────────────────────────────
  
    WA.handleFormInputAI = handleFormInputAI;
    WA.decideActions     = decideActions;
    WA.formAIController  = formAIController;
  
  })();