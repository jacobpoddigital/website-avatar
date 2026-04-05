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

  // ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────
  // After 3 consecutive OpenAI failures, disable AI actions for the rest of
  // the session. The chat itself keeps working — only smart actions stop.
  let _aiFailures  = 0;
  let _aiDisabled  = false;
  const AI_FAILURE_THRESHOLD = 3;

  function _recordAISuccess() { _aiFailures = 0; }
  function _recordAIFailure() {
    _aiFailures++;
    if (_aiFailures >= AI_FAILURE_THRESHOLD && !_aiDisabled) {
      _aiDisabled = true;
      console.warn('[WA] OpenAI unavailable — AI actions disabled for this session');
    }
  }

  // ─── FORM AI ──────────────────────────────────────────────────────────────

  const SKIP_PHRASES = [
    'are you still there', 'still there', "you're not responding",
    'gotten distracted', 'stepped away', 'seems like you'
  ];

  async function handleFormInputAI(userText, fields, recentMessages) {
    if (_aiDisabled) return { error: 'network', message: "I'm not able to process that right now — could you try again later?" };

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
        signal:  AbortSignal.any([formAIController.signal, AbortSignal.timeout(10000)]),
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

      _recordAISuccess();
      return parsed;

    } catch(e) {
      if (e.name === 'AbortError') {
        if (WA.DEBUG) console.log('[WA] Form AI cancelled');
        return { error: 'cancelled' };
      }
      console.warn('[WA] Form AI error:', e.message);
      _recordAIFailure();
      return { error: 'network', message: "I'm having trouble processing that — could you try again?" };
    }
  }

  // ─── KNOWLEDGE CONTEXT PARSER ─────────────────────────────────────────────

  function parseKnowledgeIntent(knowledgeContext, pageMap) {
    if (!knowledgeContext) return null;
    
    const { intent, target_page, section, confidence, keywords } = knowledgeContext;
    
    // ──────────────────────────────────────────────────────────────────────
    // GATE 1: Must have at least one of intent, target_page, or section
    // ──────────────────────────────────────────────────────────────────────
    if (!intent && !target_page && !section) {
      if (WA.DEBUG) console.log('[WA] No intent, target_page, or section — skipping OpenAI');
      return { actions: [] };
    }
    
    // ──────────────────────────────────────────────────────────────────────
    // GATE 2: Confidence must be high enough
    // ──────────────────────────────────────────────────────────────────────
    if ((confidence || 0) < 0.8) {
      if (WA.DEBUG) console.log('[WA] Knowledge context confidence too low:', confidence, '— skipping OpenAI');
      return { actions: [] };
    }
    
    // ──────────────────────────────────────────────────────────────────────
    // GATE 3: Must have navigation context (target_page or section)
    // ──────────────────────────────────────────────────────────────────────
    if (!target_page && !section) {
      if (WA.DEBUG) console.log('[WA] No target_page or section — skipping OpenAI');
      return { actions: [] };
    }
    
    // ──────────────────────────────────────────────────────────────────────
    // ALL GATES PASSED: Proceed to OpenAI with knowledge context
    // ──────────────────────────────────────────────────────────────────────
    if (WA.DEBUG) {
      console.log('[WA] Actionable knowledge context — proceeding to OpenAI');
      console.log('[WA] Intent:', intent, '| Page:', target_page, '| Section:', section, '| Keywords:', keywords);
    }
    
    return null; // Signal: call OpenAI
  }

  // ─── TRANSFORM PAGE CONTEXT FOR OPENAI ────────────────────────────────────
  
  function transformPageContextForAI(pageContext) {
    // Transform WA.PAGE_CONTEXT.page.sections into a compact format for OpenAI.
    // Keep only what the model needs: id, title, sectionType, a short summary, and
    // subsection ids/titles for targeting. Strip keywords and long subsection summaries
    // to keep prompt size manageable.
    const elements = [];

    if (pageContext?.page?.sections) {
      pageContext.page.sections.forEach((section, idx) => {
        const el = {
          id: section.id || `wa_section_${idx}`,
          sectionType: section.type,
          title: section.title,
          summary: (section.summary || '').slice(0, 120),
          actions: ['scroll_to']
        };

        // Include subsections for targeting — id and title only
        if (section.subsections && section.subsections.length > 0) {
          el.subsections = section.subsections.map(sub => ({
            id: sub.id,
            title: sub.title
          }));
        }

        elements.push(el);
      });
    }

    return elements;
  }

  // ─── ACTION DECISION ENGINE ───────────────────────────────────────────────

  async function decideActions(userMessage, agentMessage, knowledgeContext, pageContext, recentMessages, actions) {

    // ──────────────────────────────────────────────────────────────────────
    // GUARD: Circuit breaker — AI disabled for this session
    // ──────────────────────────────────────────────────────────────────────
    if (_aiDisabled) return null;

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
    // CHECK: Knowledge context decision
    // ──────────────────────────────────────────────────────────────────────
    if (knowledgeContext) {
      const pageMap = WA.getPageMap ? WA.getPageMap() : [];
      const knowledgeResult = parseKnowledgeIntent(knowledgeContext, pageMap);
      
      // If result is { actions: [] }, skip OpenAI
      if (knowledgeResult !== null) {
        return knowledgeResult;
      }
      
      // Result is null → proceed to OpenAI call below
    } else {
      // No knowledge context at all → skip OpenAI
      if (WA.DEBUG) console.log('[WA] No knowledge context — skipping OpenAI');
      return null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // CALL OPENAI: High-confidence actionable intent exists
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

    // Transform page context sections into elements format
    const elements = transformPageContextForAI(pageContext);
    const pageEls = elements.length > 0
      ? JSON.stringify(elements, null, 2)
      : '[]';

    const recentMsgs = (Array.isArray(recentMessages) ? recentMessages : []).map(m =>
      `${m.role === 'user' ? 'U' : 'M'}: ${m.text}`
    ).join('\n');

    // Add knowledge context to OpenAI prompt
    const knowledgeSection = knowledgeContext ? `
KNOWLEDGE CONTEXT:
Intent: ${knowledgeContext.intent || 'unknown'}
Target page: ${knowledgeContext.target_page || 'none'}
Section: ${knowledgeContext.section || 'none'}
Confidence: ${knowledgeContext.confidence}
Keywords (from speech): ${knowledgeContext.keywords?.join(', ') || 'none'}
Matched text: "${knowledgeContext.matched_text?.slice(0, 100) || ''}..."
` : '';

    const prompt = `You are deciding what actions a website chat widget should take after the agent spoke.

CURRENT PAGE: ${document.title}
URL: ${currentUrl}

AVAILABLE PAGES (label|url):
${pages}

PAGE SECTIONS (JSON array):
${pageEls}

RECENT CONVERSATION:
${recentMsgs}

AGENT JUST SAID: "${agentMessage}"

${knowledgeSection}

Reply with JSON only:
{
  "actions": [
    {
      "type": "scroll_to"|"navigate"|"fill_form"|"navigate_then_fill"|"none",
      "auto": true|false,
      "section_id": "id from sections array or null",
      "subsection_id": "id of specific subsection or null",
      "target_url": "exact url from pages list or null",
      "target_label": "human-readable page/section name",
      "reason": "brief user-friendly message for why this is relevant to the intent",
      "confidence": 0.0-1.0 (how confident you are this matches user intent)
    }
  ]
}

RULES:
- Empty [] if no action needed
- Return multiple actions when there are several valid options (e.g., multiple relevant sections)
- Order actions by confidence score (highest first)
- auto:true = execute now (scroll_to automatically)
- auto:false = confirm first (navigate, fill_form)
- target_label REQUIRED for all navigate/scroll actions - use the exact section title or page name
- reason must be user-friendly
- section_id should match the "id" field from the sections array
- When the user is asking about a specific subsection (e.g. a specific article, service, or feature), set subsection_id to that subsection's id and section_id to its parent section's id; target_label should be the subsection title
- When the user is asking about a parent section generally, leave subsection_id null
- When keywords from speech are provided, prioritize sections and pages that match those keywords
- summary field helps verify relevance before suggesting scroll
- sectionType helps identify the purpose (hero=intro, pricing=costs, contact=forms, etc.)
- If target page matches current URL (both are paths), use scroll_to. If different, use navigate.
- Use scroll_to only when already on the target page
- confidence: 1.0 = perfect match, 0.8 = strong match, 0.6 = possible match, <0.5 = weak/uncertain
- Boost confidence when section keywords align with keywords from user speech
- Max 4 actions (prioritize quality over quantity)`;

    const t0 = Date.now();
    if (WA.DEBUG) console.log('[WA] → Action decision request sent to OpenAI');

    try {
      const res = await fetch(OPENAI_PROXY, {
        method:  'POST',
        signal:  AbortSignal.any([decideController.signal, AbortSignal.timeout(10000)]),
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

      _recordAISuccess();
      return parsed;

    } catch(e) {
      if (e.name === 'AbortError') {
        if (WA.DEBUG) console.log('[WA] Action decision cancelled — superseded');
      } else {
        console.warn('[WA] Action decision failed:', e.message);
        _recordAIFailure();
      }
      return null;
    }
  }

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.handleFormInputAI = handleFormInputAI;
  WA.decideActions     = decideActions;
  WA.formAIController  = formAIController;

})();