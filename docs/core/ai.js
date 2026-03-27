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

    const recentMsgs = (Array.isArray(recentMessages) ? recentMessages : []).map(m =>
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

  // ─── KNOWLEDGE CONTEXT PARSER ─────────────────────────────────────────────

  function parseKnowledgeIntent(knowledgeContext, pageMap) {
    if (!knowledgeContext || !knowledgeContext.intent) return null;
    
    const { intent, target_page, section, confidence } = knowledgeContext;
    
    // Only trust high-confidence knowledge context
    if ((confidence || 0) < 0.8) {
      if (WA.DEBUG) console.log('[WA] Knowledge context confidence too low:', confidence);
      return null;
    }
    
    // ──────────────────────────────────────────────────────────────────────
    // INFORMATIONAL: No target_page AND no section = just conversation
    // ──────────────────────────────────────────────────────────────────────
    if (!target_page && !section) {
      if (WA.DEBUG) console.log('[WA] Knowledge context is informational (no target/section):', intent);
      return { actions: [] }; // Explicitly: no action needed
    }
    
    const actions = [];
    
    // ──────────────────────────────────────────────────────────────────────
    // NAVIGATE: Has target_page
    // ──────────────────────────────────────────────────────────────────────
    if (target_page) {
      const domain = window.location.origin;
      const page = pageMap.find(p => {
        const path = p.file.replace(domain, '');
        return path === target_page || p.file === target_page;
      });
      
      if (page) {
        actions.push({
          type: 'navigate',
          auto: false,
          element_id: null,
          target_url: page.file,
          target_label: page.label,
          reason: `Agent recommended navigating to ${page.label}`,
          confidence: confidence || 0.9
        });
        
        if (WA.DEBUG) console.log('[WA] Knowledge context parsed navigate action:', page.label);
      } else {
        if (WA.DEBUG) console.warn('[WA] Knowledge context target_page not found in page map:', target_page);
        return null; // Page not found, let OpenAI try
      }
    }
    
    // ──────────────────────────────────────────────────────────────────────
    // SCROLL: Has section but no target_page (same page scroll)
    // ──────────────────────────────────────────────────────────────────────
    if (section && !target_page) {
      // Would need to search page context for matching section element
      // For now, defer to OpenAI which has full page context
      if (WA.DEBUG) console.log('[WA] Knowledge context wants scroll to section, deferring to OpenAI');
      return null;
    }
    
    // ──────────────────────────────────────────────────────────────────────
    // CONTACT/FORM: Explicit form fill intent
    // ──────────────────────────────────────────────────────────────────────
    if (intent.includes('contact') || intent.includes('form') || intent.includes('enquiry')) {
      actions.push({
        type: 'fill_form',
        auto: false,
        element_id: null,
        target_url: null,
        target_label: 'Contact Form',
        reason: 'Agent suggested filling out the contact form',
        confidence: confidence || 0.9
      });
      
      if (WA.DEBUG) console.log('[WA] Knowledge context parsed form fill action');
    }
    
    return actions.length > 0 ? { actions } : null;
  }

  // ─── ACTION DECISION ENGINE ───────────────────────────────────────────────

  async function decideActions(userMessage, agentMessage, knowledgeContext, pageContext, recentMessages, actions) {

    // ──────────────────────────────────────────────────────────────────────
    // GUARD: Action already pending/active
    // ──────────────────────────────────────────────────────────────────────
    if (actions.some(a => ['pending','active'].includes(a.status))) {
      if (WA.DEBUG) console.log('[WA] Action decision skipped — action already active');
      return null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // GUARD: Generic conversational phrases
    // ──────────────────────────────────────────────────────────────────────
    if (SKIP_PHRASES.some(p => agentMessage.toLowerCase().includes(p))) {
      if (WA.DEBUG) console.log('[WA] Action decision skipped — generic phrase');
      return null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // PRIMARY: High-confidence knowledge context
    // ──────────────────────────────────────────────────────────────────────
    if (knowledgeContext && knowledgeContext.confidence >= 0.8) {
      const pageMap = WA.getPageMap ? WA.getPageMap() : [];
      const knowledgeActions = parseKnowledgeIntent(knowledgeContext, pageMap);
      
      if (knowledgeActions !== null) {
        // Could be { actions: [...] } or { actions: [] }
        if (WA.DEBUG) console.log('[WA] Using knowledge context result:', knowledgeActions);
        return knowledgeActions;
      }
      
      // knowledgeActions is null → knowledge context couldn't parse it
      // Fall through to OpenAI
      if (WA.DEBUG) console.log('[WA] Knowledge context could not parse intent, deferring to OpenAI');
    }

    // ──────────────────────────────────────────────────────────────────────
    // FALLBACK: Call OpenAI for action decision
    // ──────────────────────────────────────────────────────────────────────
    
    // Cancel any in-flight request
    if (decideController) decideController.abort();
    decideController = new AbortController();

    const domain = window.location.origin;
    const pageMap = WA.getPageMap ? WA.getPageMap() : [];
    const pages = pageMap.map(p => {
      const path = p.file.replace(domain, '');
      return `${p.label}|${path}`;
    }).join('\n');

    const currentUrl = window.location.pathname;

    const pageEls = pageContext?.elements?.length
      ? JSON.stringify(pageContext.elements.map(e => {
          const el = {
            id: e.id,
            type: e.type,
            actions: e.actions
          };
          
          // Add type-specific content fields
          if (e.summary) {
            el.title = e.title;
            el.summary = e.summary;
            el.tokens = e.tokens;
          } else if (e.context) {
            el.text = e.text || e.title;
            el.context = e.context;
          } else if (e.text) {
            el.text = e.text;
          } else if (e.title) {
            el.title = e.title;
          } else if (e.number) {
            el.number = e.number;
          } else if (e.email) {
            el.email = e.email;
          } else if (e.alt) {
            el.alt = e.alt;
          }
          
          return el;
        }), null, 2)
      : '[]';

    const recentMsgs = (Array.isArray(recentMessages) ? recentMessages : []).map(m =>
      `${m.role === 'user' ? 'U' : 'M'}: ${m.text}`
    ).join('\n');

    // Add knowledge context if available
    const knowledgeSection = knowledgeContext ? `
KNOWLEDGE CONTEXT (from agent's response):
Intent: ${knowledgeContext.intent || 'unknown'}
Target page: ${knowledgeContext.target_page || 'none'}
Section: ${knowledgeContext.section || 'none'}
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

PAGE ELEMENTS (JSON array with full element details):
${pageEls}

Element types:
- section: has title, summary (compressed content), tokens
  → May have subsections array: nested items each with title, url, description, tokens
  → Use subsections to understand detailed offerings within a section
  → Example: "Our services Design & Creative" section contains subsections for "Web Design", "Content Marketing", etc.
- button: has text, context (parent section name)
- video: has title, context
- phone: has number
- email: has email
- image: has alt

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
      "element_id": "wa_el_N or null",
      "target_url": "exact url from pages list or null",
      "target_label": "human-readable page/section name",
      "reason": "brief reason why this action is relevant",
      "confidence": 0.0-1.0 (how confident you are this matches user intent)
    }
  ]
}

RULES:
- Empty [] if no action needed
- Return multiple actions when there are several valid options (e.g., "browse product page" AND "add to cart")
- Order actions by confidence score (highest first)
- auto:true = execute now (scroll_to automatically)
- auto:false = confirm first (navigate, fill_form, click_element)
- target_label REQUIRED for all navigate/scroll actions - use the exact page name or section title
- element_id uses full format (wa_el_5 not just 5)
- Sections may have subsections - check subsections array for specific services/offerings
- When agent mentions a specific service (e.g., "SEO", "Web Design"), look in section subsections
- Sections include summary field - verify relevance before suggesting scroll
- Buttons include context field - prefer buttons in relevant context
- If target_page matches current URL (both are paths), use scroll_to. If different, use navigate.
- Use scroll_to only when already on the target page
- confidence: 1.0 = perfect match, 0.8 = strong match, 0.6 = possible match, <0.5 = weak/uncertain
- Max 4 actions (prioritize quality over quantity)`;

    const t0 = Date.now();
    if (WA.DEBUG) console.log('[WA] → Action decision request sent (OpenAI fallback)');

    try {
      const res = await fetch(OPENAI_PROXY, {
        method:  'POST',
        signal:  decideController.signal,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt, maxTokens: 300 })
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