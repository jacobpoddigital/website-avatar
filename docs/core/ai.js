/**
 * core/ai.js — OpenAI Integration
 * Form fill AI conversation
 * Pure async functions - return data, don't mutate global state directly
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const CONFIG = window.WA_CONFIG || {};
  const OPENAI_PROXY = CONFIG.openaiProxyUrl || 'https://backend.jacob-e87.workers.dev/classify';

  let formAIController = null;

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

  // ─── EXPOSE ───────────────────────────────────────────────────────────────

  WA.handleFormInputAI = handleFormInputAI;
  WA.formAIController  = formAIController;

})();